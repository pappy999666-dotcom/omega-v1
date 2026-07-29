// ============================================================
// WA-Bridge — WhatsApp Event Handler
// Processes incoming messages, dispatches commands.
// ALL outgoing responses pass through the centralized
// PreviewManager — the single source of truth for previews.
// ============================================================

import type { BridgeWASocket as WASocket, BaileysEventMap, IMessage, WebMessageInfo } from './baileys-types.js';
import { parseCommand, parseStickerCommand, hashSticker } from './command-parser.js';
import { loadSessionConfig, loadSessionMeta, updateSessionMeta, saveSessionMeta, getGlobalMenuUrl } from '../services/workspace.js';
import { stopSpamLoop, isSpamLoopActive, cmdToChat, cmdToChatX, cmdSStatus, cmdGroupStatus } from './commands/status.js';
import { cmdAllStatus, stopAllStatus, isAllStatusRunning } from './commands/all-status.js';
import { cmdAllChat, stopOutreach, isOutreachRunning } from './commands/mass-outreach.js';
import { cmdJoin, cmdLeave, cmdJoinAll, cmdLeaveAll, resolveGroupJid } from './commands/lifecycle.js';
import { cmdTag, cmdMTag, tagSummary } from './commands/tag.js';
import { updateSessionConfig, addToMainBucket } from '../services/workspace.js';
import { logger } from '../utils/logger.js';
import { isFrozen, reinitSocket, normalizePairingPhone } from './socket-manager.js';
import {
  whatsappMenu,
  asciiBox,
  bold,
  italic,
  quote,
  errorCard,
  successCard,
  warningCard,
  pingCard,
  infoCard,
  sudoListCard,
  groupsCard,
} from '../utils/ascii-art.js';
// ── SINGLE IMPORT: All preview operations go through PreviewManager ──
import { PreviewManager } from '../preview-engine/index.js';
import { statusDesignEngine } from '../services/StatusDesignEngine.js';
import type { SessionMeta } from '../types/index.js';
import { pendingGcCodes } from '../telegram/bot.js';

// Map from sessionId → telegramId (populated at init)
const sessionOwnerMap = new Map<string, string>();

// Persistent cache for menu URL externalAdReply — fetched once, reused forever
const menuAdReplyCache = new Map<string, { title: string; body: string; thumbnailUrl?: string }>();



export function registerSessionOwner(sessionId: string, telegramId: string): void {
  sessionOwnerMap.set(sessionId, telegramId);
}

export function unregisterSessionOwner(sessionId: string): void {
  sessionOwnerMap.delete(sessionId);
}

export function normalizeWhatsAppNumber(value: string | null | undefined): string {
  if (!value) return '';
  const user = value.split('@')[0]!.split(':')[0]!;
  return user.replace(/\D/g, '');
}

export function isAuthorizedCommandSender(
  fromMe: boolean,
  senderJid: string | null | undefined,
  sudoNumbers: string[] = []
): boolean {
  if (fromMe) return true;
  const sender = normalizeWhatsAppNumber(senderJid);
  return Boolean(sender && sudoNumbers.some((number) => normalizeWhatsAppNumber(number) === sender));
}

function extractMessageText(message: IMessage | null | undefined): string {
  if (!message) return '';
  const wrapped = message.ephemeralMessage?.message
    ?? message.viewOnceMessage?.message
    ?? message.viewOnceMessageV2?.message
    ?? message.documentWithCaptionMessage?.message;
  if (wrapped) return extractMessageText(wrapped);
  return message.conversation
    ?? message.extendedTextMessage?.text
    ?? message.imageMessage?.caption
    ?? message.videoMessage?.caption
    ?? message.documentMessage?.caption
    ?? '';
}

// ── Sudo Resolution ───────────────────────────────────────
// Priority: raw args → quoted msg sender → @mentioned JIDs

function resolveSudoTargets(
  args: string[],
  msg: WebMessageInfo
): string[] {
  // 1. Raw phone numbers in args
  if (args.length > 0) {
    const numbers = args
      .map((a) => normalizeWhatsAppNumber(a))
      .filter((n) => n.length >= 7);
    if (numbers.length > 0) return numbers;
  }

  const contextInfo =
    msg.message?.extendedTextMessage?.contextInfo
    ?? msg.message?.imageMessage?.contextInfo
    ?? msg.message?.videoMessage?.contextInfo;

  // 2. Quoted message — resolve sender JID
  if (contextInfo?.participant) {
    const n = normalizeWhatsAppNumber(contextInfo.participant);
    if (n.length >= 7) return [n];
  }

  // 3. @mentioned JIDs
  if (contextInfo?.mentionedJid?.length) {
    const numbers = (contextInfo.mentionedJid as string[])
      .map((jid) => normalizeWhatsAppNumber(jid))
      .filter((n) => n.length >= 7);
    if (numbers.length > 0) return numbers;
  }

  return [];
}

// ── Main Event Router ─────────────────────────────────────

export async function handleWAEvent(
  sessionId: string,
  event: keyof BaileysEventMap,
  data: unknown,
  socket: WASocket
): Promise<void> {
  if (event === 'messages.upsert') {
    await handleMessages(sessionId, data as { messages: WebMessageInfo[]; type: string }, socket);
  }
}

/** Execute command text without sending that command into any WhatsApp chat. */
export async function executeBridgeCommand(
  sessionId: string,
  telegramId: string,
  text: string,
  socket: WASocket,
  onReply: (text: string) => Promise<void>
): Promise<void> {
  if (loadSessionConfig(telegramId, sessionId).sleeping) throw new Error('User sleep mode is active');

  // Use the bot's own JID as remoteJid so isGroup=false but commands still run.
  // For commands that need a group JID (allstatus, allchat etc.) the command
  // itself fetches groups internally — remoteJid is only used for reply routing.
  const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? `${telegramId}@s.whatsapp.net`;
  const syntheticMessage = {
    key: { remoteJid: ownJid, fromMe: true, id: `bridge-${Date.now()}` },
    message: { conversation: text },
  } as WebMessageInfo;

  await processMessage(sessionId, telegramId, syntheticMessage, socket, onReply);
}

// ── Message Handler ───────────────────────────────────────

async function handleMessages(
  sessionId: string,
  upsert: { messages: WebMessageInfo[]; type: string },
  socket: WASocket
): Promise<void> {
  if (upsert.type !== 'notify') return;

  const telegramId = sessionOwnerMap.get(sessionId);
  if (!telegramId) return;

  for (const msg of upsert.messages) {
    if (!msg.message) continue;

    // ── One-time GC join code check ──────────────────────────────
    const msgGroupJid = msg.key.remoteJid ?? '';
    if (msgGroupJid.endsWith('@g.us') && !msg.key.fromMe) {
      const rawText = extractMessageText(msg.message).trim().toUpperCase();
      const codeKey = `${sessionId}:${msgGroupJid}`;
      const pending = pendingGcCodes.get(codeKey);
      if (pending && rawText === pending.code) {
        if (Date.now() < pending.expires) {
          pendingGcCodes.delete(codeKey);
          const senderJid = msg.key.participant ?? msg.key.remoteJid ?? '';
          try {
            await (socket as unknown as {
              groupParticipantsUpdate(jid: string, participants: string[], action: string): Promise<unknown>;
            }).groupParticipantsUpdate(msgGroupJid, [senderJid], 'promote');
            await socket.sendMessage(msgGroupJid, { text: `✅ @${senderJid.split('@')[0]} has been promoted to admin.`, mentions: [senderJid] });
            logger.info('[GCCode] Promoted via join code', { sessionId, senderJid, groupJid: msgGroupJid });
          } catch (err) {
            logger.warn('[GCCode] Promote failed', { err: String(err) });
          }
        } else {
          pendingGcCodes.delete(codeKey);
        }
        continue;
      }
    }

    await processMessage(sessionId, telegramId, msg, socket).catch((err) => {
      logger.error('[EventHandler] Message processing error', {
        sessionId,
        err: err.message,
      });
    });
  }
}

async function processMessage(
  sessionId: string,
  telegramId: string,
  msg: WebMessageInfo,
  socket: WASocket,
  replyOverride?: (text: string) => Promise<void>
): Promise<void> {
  const groupJid = msg.key.remoteJid ?? '';
  const isGroup = groupJid.endsWith('@g.us');

  // Extract text from various message types
  const text = extractMessageText(msg.message);
  const quotedMessage = (
    msg.message?.extendedTextMessage?.contextInfo
    ?? msg.message?.imageMessage?.contextInfo
    ?? msg.message?.videoMessage?.contextInfo
  )?.quotedMessage;
  const quotedText = extractMessageText(quotedMessage);
  // Stage 1: Extract existing preview from quoted message via PreviewManager
  const quotedPreview = PreviewManager.extractIncomingPreview(quotedMessage);
  // As-is relay: use preview-router to detect sourceExt for chat commands
  const { resolvePreviewRoute } = await import('./preview-router.js');
  const chatRoute = resolvePreviewRoute(msg, text);
  const sourceExt = chatRoute.route === 'AS_IS' ? chatRoute.sourceExt : undefined;

  // Extract sticker for macro matching
  const stickerMsg = msg.message?.stickerMessage;

  const config = loadSessionConfig(telegramId, sessionId);
  const sessionMeta = loadSessionMeta(telegramId, sessionId);

  // Passive collection is intentionally silent and runs before command parsing.
  if (sessionMeta?.linkCollectionEnabled && text) {
    const links: string[] = [...new Set<string>(String(text).match(/https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/gu) ?? [])];
    if (links.length > 0) {
      const result = addToMainBucket(telegramId, links, sessionId);
      if (result.added > 0) {
        updateSessionMeta(telegramId, sessionId, {
          linksCollected: (sessionMeta.linksCollected ?? 0) + result.added,
        });
      }
    }
  }

  // User sleep mode disables WhatsApp commands without affecting passive collection.
  if (config.sleeping && !replyOverride) return;

  // Parse command. Unknown text and unbound stickers are always ignored.
  let parsed = text ? parseCommand(text, config) : null;
  if (!parsed && stickerMsg?.fileSha256) {
    parsed = parseStickerCommand(Buffer.from(stickerMsg.fileSha256 as Uint8Array), config);
  }
  if (!parsed) return;

  const { command, args } = parsed;

  // ── Lazy group participant fetch (for hidetag) ────────────
  // Cached per processMessage call; never throws.
  let _groupParticipants: string[] | null = null;
  const getGroupParticipants = async (): Promise<string[]> => {
    if (!isGroup) return [];
    if (_groupParticipants !== null) return _groupParticipants;
    try {
      const meta = await socket.groupMetadata(groupJid);
      _groupParticipants = meta.participants.map((p: { id: string }) => p.id);
    } catch {
      _groupParticipants = [];
    }
    return _groupParticipants;
  };

  // ── Enriched WhatsApp reply ───────────────────────────────
  // Replies with a global menu URL use Baileys native nativeFlowMessage
  // (cta_url button) so the URL appears as a real clickable CTA button
  // at the bottom of the message instead of an ad-reply preview card.
  const baseWhatsAppReply = async (replyText: string): Promise<void> => {
    const globalMenuUrl = getGlobalMenuUrl();
    const mentions = await getGroupParticipants();

    let visibleText = replyText;

    if (globalMenuUrl) {
      const isJid = globalMenuUrl.includes('@g.us') || globalMenuUrl.includes('@newsletter') || globalMenuUrl.includes('@s.whatsapp.net');
      if (!isJid) {
        const cleanUrl = globalMenuUrl.split('?')[0]!;

        // Strip the raw URL from visible text if it's embedded
        if (visibleText.includes(cleanUrl)) {
          visibleText = visibleText.replace(cleanUrl, '').replace(/\n\s*\n/g, '\n').trim();
        }

        // Resolve display title (cached)
        if (!menuAdReplyCache.has(cleanUrl)) {
          let title = '';
          let body = '';
          let thumbnailUrl: string | undefined;
          // WA channel link
          const channelMatch = cleanUrl.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/);
          if (channelMatch) {
            try {
              const sock = socket as unknown as { newsletterMetadata: (type: string, key: string) => Promise<{ name?: string; description?: string; picture?: string }> };
              const meta = await sock.newsletterMetadata('invite', channelMatch[1]!);
              title = meta?.name || 'Join Channel';
              body = meta?.description || '';
              thumbnailUrl = meta?.picture || undefined;
            } catch { /* non-critical */ }
          } else if (cleanUrl.includes('chat.whatsapp.com')) {
            // WA group link
            try {
              const code = cleanUrl.split('chat.whatsapp.com/')[1]?.split(/[?#]/)[0]!;
              const sock = socket as unknown as { groupGetInviteInfo: (c: string) => Promise<{ id: string; subject?: string }>; profilePictureUrl: (jid: string, t: string) => Promise<string> };
              const info = await sock.groupGetInviteInfo(code);
              title = info?.subject || 'Join Group';
              thumbnailUrl = info?.id ? await sock.profilePictureUrl(info.id, 'image').catch(() => undefined) : undefined;
            } catch { /* non-critical */ }
          } else {
            // Regular URL — fetch OG metadata
            try {
              const meta = await PreviewManager.fetchLinkMeta(cleanUrl);
              title = meta?.title || '';
              body = meta?.description || '';
              thumbnailUrl = meta?.imageUrl || undefined;
            } catch { /* non-critical */ }
          }
          menuAdReplyCache.set(cleanUrl, { title, body, thumbnailUrl });
        }

        const cached = menuAdReplyCache.get(cleanUrl)!;
        const displayText = cached.title || '🔗 Open Menu';

        // ── Native nativeFlowMessage URL button (Baileys native flow) ──
        try {
          const sock = socket as unknown as {
            sendMessage(jid: string, content: Record<string, unknown>, opts?: Record<string, unknown>): Promise<unknown>;
          };
          await sock.sendMessage(
            groupJid,
            {
              interactiveMessage: {
                body: { text: visibleText },
                footer: { text: '' },
                header: { hasMediaAttachment: false },
                nativeFlowMessage: {
                  buttons: [{
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                      display_text: displayText,
                      url: cleanUrl,
                      merchant_url: cleanUrl,
                    }),
                  }],
                  messageParamsJson: '',
                },
              },
              ...(mentions.length > 0 ? { mentions } : {}),
            } as Record<string, unknown>,
            { quoted: msg }
          );
          return;
        } catch (err) {
          // Non-critical: fall through to plain reply below
          logger.warn('[EventHandler] Native URL button send failed, falling back to plain reply', { err: String(err) });
        }
      }
    }

    // Plain reply — no menu URL configured (or JID-based menu, or button failed)
    await PreviewManager.send(socket as any, groupJid, visibleText, {
      quoted: msg,
      extra: mentions.length > 0 ? { mentions } : undefined,
    });
  };

  const reply = replyOverride ?? baseWhatsAppReply;
  const createProgressReply = async (initialText: string): Promise<(nextText: string) => Promise<void>> => {
    if (replyOverride) {
      await replyOverride(initialText);
      return replyOverride;
    }
    const sent = await socket.sendMessage(groupJid, { text: initialText }, { quoted: msg }) as { key?: import("@crysnovax/baileys").WAMessageKey } | undefined;
    const key = sent?.key;
    return async (nextText: string) => {
      if (!key) {
        await socket.sendMessage(groupJid, { text: nextText });
        return;
      }
      try {
        await socket.sendMessage(groupJid, { text: nextText, edit: key });
      } catch {
        await socket.sendMessage(groupJid, { text: nextText });
      }
    };
  };
  const commandText = (fallback = ''): string => args.join(' ').trim() || quotedText.trim() || fallback;

  const senderJid = msg.key.participant ?? (msg.key.fromMe ? (socket as { user?: { id?: string } }).user?.id : msg.key.remoteJid);
  const isOwnerSender = Boolean(msg.key.fromMe);
  if (!replyOverride && !isAuthorizedCommandSender(isOwnerSender, senderJid, config.sudoNumbers)) {
    logger.warn('[EventHandler] Silently ignored unauthorized WhatsApp command', {
      sessionId,
      command,
      sender: normalizeWhatsAppNumber(senderJid),
    });
    return;
  }

  logger.info(`[EventHandler] Command: ${command}`, {
    sessionId,
    groupJid,
    sender: isOwnerSender ? 'owner' : normalizeWhatsAppNumber(senderJid),
  });

  // ── Command Dispatch ──────────────────────────────────────

  switch (command) {

    // ── Ping ──
    case 'ping': {
      const latency = Date.now();
      // Send first, then measure round-trip
      const updatePing = await createProgressReply(pingCard({ latency: 0, sessionId, status: 'MEASURING' }));
      await updatePing(pingCard({ latency: Date.now() - latency, sessionId, status: isFrozen(sessionId) ? 'FROZEN' : 'ONLINE' }));
      break;
    }

    // ── Menu ──
    case 'menu':
    case 'help': {
      await reply(whatsappMenu('WA-BRIDGE CONTROL', [
        {
          heading: '◈ STATUS ENGINE',
          items: [
            { cmd: config.prefix + 'godcast', desc: 'Designed current-GC status' },
            { cmd: config.prefix + 'statusdesign', desc: 'Designed current-GC status' },
            { cmd: config.prefix + 'settheme', desc: 'Set status theme' },
            { cmd: config.prefix + 'smedia', desc: 'Post media status' },
            { cmd: config.prefix + 'gstatus [msg]', desc: 'Post to current group status' },
            { cmd: config.prefix + 'tochat [jid] [msg]', desc: 'Send to a target group' },
            { cmd: config.prefix + 'togstatus [jid] [msg]', desc: 'Post to a target group status' },
            { cmd: config.prefix + 'tochatx [jid] [n] [msg]', desc: 'Repeat a target chat send' },
            { cmd: config.prefix + 'togstatusx [n] [jid] [msg]', desc: 'Repeat a target group status' },
            { cmd: config.prefix + 'sstatus [msg]', desc: 'Run status loop until stopspam' },
          ],
        },
        {
          heading: '◈ BROADCAST NETWORK',
          items: [
            { cmd: config.prefix + 'allstatus [msg]', desc: 'Post to all group statuses' },
            { cmd: config.prefix + 'allstatusx [n] [msg]', desc: 'Repeat across every group' },
            { cmd: config.prefix + 'allchat [msg]', desc: 'Send to all groups with hidetag' },
            { cmd: config.prefix + 'stopspam', desc: 'Stop the active status loop' },
          ],
        },
        {
          heading: '◈ LIFECYCLE MODULE',
          items: [
            { cmd: config.prefix + 'join [link]', desc: 'Join a group' },
            { cmd: config.prefix + 'leave [jid]', desc: 'Leave a group' },
            { cmd: config.prefix + 'joinall', desc: 'Join all active bucket links' },
            { cmd: config.prefix + 'left', desc: 'Leave the current group' },
            { cmd: config.prefix + 'leaveall', desc: 'Leave all groups' },
          ],
        },
        {
          heading: '◈ TAG ENGINE',
          items: [
            { cmd: config.prefix + 'tag', desc: 'Hidetag all members' },
            { cmd: config.prefix + 'mtag', desc: 'Visible mention all members' },
          ],
        },
        {
          heading: '◈ PAIRING',
          items: [
            { cmd: config.prefix + 'pair [phone]', desc: 'Pair a new WA number from WhatsApp' },
          ],
        },
        {
          heading: '◈ SYSTEM CONFIG',
          items: [
            { cmd: config.prefix + 'setprefix [p]', desc: 'Change command prefix' },
            { cmd: config.prefix + 'setcmd [cmd]', desc: 'Bind quoted sticker to command' },
            { cmd: config.prefix + 'delcmd', desc: 'Delete quoted sticker binding' },
            { cmd: config.prefix + 'setsudo [number]', desc: 'Grant command access (or reply to msg)' },
            { cmd: config.prefix + 'delsudo [number]', desc: 'Revoke command access' },
            { cmd: config.prefix + 'info', desc: 'Session information' },
            { cmd: config.prefix + 'groups', desc: 'List joined groups' },
          ],
        },
      ]));
      break;
    }

    // ── Info ──
    case 'info': {
      let groupCount = 0;
      try {
        const groups = await socket.groupFetchAllParticipating();
        groupCount = Object.keys(groups).length;
      } catch { /* ignore */ }

      await reply(infoCard({
        sessionId,
        status: isFrozen(sessionId) ? 'FROZEN' : 'ONLINE',
        groups: groupCount,
        prefix: config.prefix || 'null',
        nullMode: config.nullPrefix,
        spamLoop: isSpamLoopActive(sessionId),
        sudoCount: (config.sudoNumbers ?? []).length,
      }));
      break;
    }

    // ── Groups ──
    case 'groups': {
      try {
        const groups = await socket.groupFetchAllParticipating();
        const list = Object.values(groups);
        await reply(groupsCard(list.map((g) => ({ name: g.subject, count: g.participants.length }))));
      } catch (err) {
        await reply(errorCard('GROUPS FETCH FAILED', 'WhatsApp rejected the group list request.', String(err)));
      }
      break;
    }

    // ── Set Prefix ──
    case 'prefix':
    case 'setprefix': {
      if (command === 'prefix' && args.length === 0) {
        await reply(asciiBox({ title: 'COMMAND PREFIX', emoji: '⌨️', rows: [['Current', config.prefix || 'null'], ['Usage', `${config.prefix}setprefix <prefix>`]] }));
        break;
      }
      const newPrefix = args[0];
      if (!newPrefix) {
        await reply(asciiBox({ title: 'COMMAND PREFIX', emoji: '⌨️', rows: [['Current', config.prefix || 'null'], ['Usage', `${config.prefix}setprefix [prefix]`]] }));
        break;
      }
      updateSessionConfig(telegramId, sessionId, { prefix: newPrefix === 'null' ? '' : newPrefix, nullPrefix: newPrefix === 'null' });
      await reply(successCard('PREFIX UPDATED', `Commands now respond to: ${bold(newPrefix)}`, [['New prefix', newPrefix]]));
      break;
    }

    // ── Set Sticker Command ──
    case 'setcmd':
    case 'delcmd': {
      const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        ?? msg.message?.imageMessage?.contextInfo
        ?? msg.message?.videoMessage?.contextInfo;
      const quotedStickerHash = contextInfo?.quotedMessage?.stickerMessage?.fileSha256
        ? hashSticker(Buffer.from(contextInfo.quotedMessage.stickerMessage.fileSha256 as Uint8Array))
        : undefined;

      if (!quotedStickerHash) {
        await reply(warningCard('REPLY TO A STICKER', `Reply directly to the sticker with ${config.prefix}setcmd <command>.`));
        break;
      }

      const hash = quotedStickerHash;
      if (command === 'delcmd') {
        const macros = { ...config.stickerMacros };
        delete macros[hash];
        updateSessionConfig(telegramId, sessionId, { stickerMacros: macros });
        await reply(successCard('STICKER UNBOUND', 'The quoted sticker no longer triggers a command.', [['Hash', hash.slice(0, 12) + '…']]));
        break;
      }

      const boundCmd = args.join(' ').trim();
      const parsedBinding = boundCmd ? parseCommand(`${config.prefix}${boundCmd}`, {
        ...config,
        nullPrefix: false,
      }) : null;

      if (!parsedBinding) {
        await reply(warningCard('VALID COMMAND REQUIRED', `Reply to a sticker with ${config.prefix}setcmd <registered command>.`));
        break;
      }

      const normalizedBinding = [parsedBinding.command, ...parsedBinding.args].join(' ');
      const macros = { ...config.stickerMacros, [hash]: normalizedBinding };
      updateSessionConfig(telegramId, sessionId, { stickerMacros: macros });
      await reply(successCard('STICKER BOUND', 'The macro is active — send that sticker to execute the command.', [
        ['Hash', hash.slice(0, 12) + '…'],
        ['Command', normalizedBinding],
      ]));
      break;
    }

    // ── Sudo Access ──
    case 'sudo': {
      const sudo = config.sudoNumbers ?? [];
      await reply(sudoListCard(sudo));
      break;
    }

    case 'setsudo':
    case 'delsudo': {
      // Owner-only gate
      if (!isOwnerSender && !replyOverride) {
        await reply(errorCard('OWNER ONLY', 'Only the paired session owner can change sudo access.'));
        break;
      }

      // Resolve targets: raw args → quoted message sender → @mentions
      const targets = resolveSudoTargets(args, msg);

      if (targets.length === 0) {
        await reply(warningCard(
          'NO TARGET FOUND',
          `Provide a number, reply to someone's message, or @mention a user.\n\nUsage: ${config.prefix}${command} +2348012345678`
        ));
        break;
      }

      const current = new Set(config.sudoNumbers ?? []);
      const changed: string[] = [];

      for (const number of targets) {
        if (command === 'setsudo') {
          if (!current.has(number)) {
            current.add(number);
            changed.push(`+${number}`);
          }
        } else {
          if (current.has(number)) {
            current.delete(number);
            changed.push(`+${number}`);
          }
        }
      }

      updateSessionConfig(telegramId, sessionId, { sudoNumbers: [...current] });

      if (changed.length === 0) {
        await reply(warningCard(
          command === 'setsudo' ? 'ALREADY AUTHORIZED' : 'NOT IN LIST',
          `${targets.map((n) => `+${n}`).join(', ')} ${command === 'setsudo' ? 'already has access.' : 'was not found in the sudo list.'}`
        ));
        break;
      }

      await reply(successCard(
        command === 'setsudo' ? 'SUDO GRANTED' : 'SUDO REVOKED',
        command === 'setsudo'
          ? `${changed.length > 1 ? 'These numbers' : 'This number'} can now run commands.`
          : `Command access was removed.`,
        [
          ['Numbers', changed.join(', ')],
          ['Total sudo', String(current.size)],
        ]
      ));
      break;
    }

    // ── JID Resolver ──
    case 'jid': {
      const link = args[0];
      if (!link) { await reply(warningCard('LINK REQUIRED', `Usage: ${config.prefix}jid [group_link]`)); break; }
      const info = await resolveGroupJid(socket, link);
      if (!info) { await reply(errorCard('JID NOT RESOLVED', 'WhatsApp could not resolve that invite link.')); break; }
      await reply(asciiBox({
        title: 'GROUP IDENTITY',
        emoji: '🔑',
        rows: [
          ['JID', info.jid],
          ['Title', info.title],
          ['Members', String(info.members)],
        ],
      }));
      break;
    }

    // ── Stop ──
    case 'stop':
    case 'stopspam': {
      const target = command === 'stopspam' ? 'spam' : args[0]?.toLowerCase();
      if (target === 'spam' || target === 'all') {
        const stoppedSpam = stopSpamLoop(sessionId);
        stopOutreach(sessionId);
        await reply(successCard('OPERATIONS HALTED', stoppedSpam ? 'Status loop stopped. All outreach cancelled.' : 'Active outreach cancellation requested.'));
      } else {
        await reply(warningCard('CHOOSE A JOB', `Usage: ${config.prefix}stop spam`));
      }
      break;
    }

    // ── gstatus ──
    case 'smedia':
    case 'gstatus': {
      const text = commandText();
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Run this command inside a WhatsApp group.')); break; }
      if (!text) { await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}gstatus [message], or reply to a message.`)); break; }
      const sent = await cmdGroupStatus(socket, sessionId, groupJid, text, {
        theme: config.statusDesignTheme,
        existingPreview: quotedPreview,
        sourceMsg: msg,
      });
      await reply(sent
        ? successCard('STATUS POSTED', 'The group status was published successfully.')
        : errorCard('STATUS FAILED', 'WhatsApp rejected the group status relay.'));
      break;
    }

    // ── tochat ──
    case 'tochat': {
      const [target, ...msgParts] = args;
      const message = msgParts.join(' ').trim() || quotedText.trim();
      if (!target || !message) { await reply(warningCard('USAGE', `${config.prefix}tochat [jid/link] [message]`)); break; }
      const res = await cmdToChat(socket, sessionId, target, message, { existingPreview: quotedPreview, sourceExt });
      await reply(res.success
        ? successCard('MESSAGE DELIVERED', 'The target chat accepted the message.', [['Target', target]])
        : errorCard('DELIVERY FAILED', 'WhatsApp rejected the target message.', res.error));
      break;
    }

    // ── tochatx ──
    case 'tochatx': {
      const [target, countStr, ...msgParts] = args;
      const message = msgParts.join(' ').trim() || quotedText.trim();
      if (!target || !countStr || !message) {
        await reply(warningCard('USAGE', `${config.prefix}tochatx [jid/link] [count] [message]`));
        break;
      }
      const count = Math.min(parseInt(countStr, 10), 50);
      const res = await cmdToChatX(socket, sessionId, target, count, message, { existingPreview: quotedPreview, sourceExt });
      await reply(successCard('REPEAT DELIVERY COMPLETE', 'The operation finished.', [
        ['Target', target],
        ['Sent', `${res.sent}/${count}`],
        ['Failed', String(res.failed)],
      ]));
      break;
    }

    // ── sstatus ──
    case 'sstatus':
    case 'spam': {
      const text = args.join(' ');
      if (!text) { await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}sstatus [message]\nStop: ${config.prefix}stop spam`)); break; }
      if (isSpamLoopActive(sessionId)) { await reply(warningCard('LOOP ACTIVE', `A spam loop is already running. Use ${config.prefix}stop spam to kill it.`)); break; }
      await reply(successCard('STATUS LOOP STARTED', `Use ${config.prefix}stop spam to stop it.`, [['Message', text.slice(0, 40)]]));
      cmdSStatus(socket, sessionId, text, { theme: config.statusDesignTheme, existingPreview: quotedPreview }).catch(() => { /* background */ });
      break;
    }

    // ── statusdesign ──
    case 'settheme': {
      const requestedTheme = args[0]?.toLowerCase();
      if (!statusDesignEngine.themes.includes(requestedTheme as never)) {
        await reply(warningCard('VALID THEME REQUIRED', `Themes: ${statusDesignEngine.themes.join(', ')}\n\nUsage: ${config.prefix}settheme <theme>`));
        break;
      }
      updateSessionConfig(telegramId, sessionId, { statusDesignTheme: requestedTheme });
      await reply(successCard('THEME SAVED', 'Status designs will use this theme.', [['Theme', requestedTheme]]));
      break;
    }

    case 'godcast':
    case 'statusdesign': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Run this command inside a WhatsApp group.')); break; }
      const requestedTheme = statusDesignEngine.themes.includes(args[0]?.toLowerCase() as never)
        ? args.shift()
        : config.statusDesignTheme;
      const url = args.find((arg) => /^https?:\/\/\S+$/u.test(arg));
      if (!url) {
        await reply(warningCard('URL REQUIRED', `Usage: ${config.prefix}statusdesign [theme] [link]\nThemes: ${statusDesignEngine.themes.join(', ')}`));
        break;
      }
      try {
        const design = statusDesignEngine.render({ theme: requestedTheme, url });
        const sent = await cmdGroupStatus(socket, sessionId, groupJid, design.text, { skipDesign: true });
        await reply(sent
          ? successCard('DESIGNED STATUS PUBLISHED', `Theme applied successfully.`, [['Theme', design.theme]])
          : errorCard('STATUS RELAY FAILED', 'WhatsApp rejected the group status.'));
      } catch (error) {
        await reply(errorCard('STATUS DESIGN FAILED', 'An error occurred while generating the status.', String(error)));
      }
      break;
    }

    // ── Target Group Status ──
    case 'togstatus':
    case 'togstatusx': {
      const isX = command === 'togstatusx';
      const repeat = isX && /^\d+$/.test(args[0] ?? '') ? Math.min(Math.max(parseInt(args.shift()!), 1), 50) : 1;
      const target = args.shift();
      const message = args.join(' ').trim() || quotedText.trim();
      if (!target || !message) {
        await reply(warningCard('TARGET AND MESSAGE REQUIRED', `Usage: ${config.prefix}${command}${command.endsWith('x') ? ' <count>' : ''} <jid or invite link> <message>`));
        break;
      }
      const resolved = target.includes('chat.whatsapp.com') ? await resolveGroupJid(socket, target) : null;
      const targetJid = resolved?.jid ?? target;
      let sent = 0;
      for (let index = 0; index < repeat; index += 1) {
        if (await cmdGroupStatus(socket, sessionId, targetJid, message, {
          theme: config.statusDesignTheme,
          existingPreview: quotedPreview,
          sourceMsg: msg,
        })) sent += 1;
      }
      await reply(successCard('GROUP STATUS COMPLETE', 'The target status operation finished.', [
        ['Target', targetJid],
        ['Sent', `${sent}/${repeat}`],
      ]));
      break;
    }

    // ── allstatus ──
    case 'allstatus':
    case 'allstatusx': {
      const repeat = command === 'allstatusx' ? Math.min(Math.max(Number.parseInt(args.shift() ?? '', 10) || 0, 1), 20) : 1;
      const text = commandText();
      if (!text) {
        await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}${command}${command.endsWith('x') ? ' <count>' : ''} <message>`));
        break;
      }
      const updateProgress = await createProgressReply(asciiBox({
        title: 'BROADCAST STARTED',
        emoji: '📡',
        rows: [['Repeats', String(repeat)], ['Mode', 'ALL STATUS']],
        footer: 'Progress updates follow…',
      }));
      void (async () => {
        for (let index = 0; index < repeat; index += 1) {
          await cmdAllStatus(socket, sessionId, telegramId, text, {
            onProgress: updateProgress,
            existingPreview: quotedPreview,
            sourceExt,
          });
        }
      })().catch(async (error) => {
        logger.error('[EventHandler] allstatus failed', { sessionId, error: String(error) });
        await updateProgress(errorCard('BROADCAST FAILED', 'The background campaign could not finish.', String(error)));
      });
      break;
    }

    // ── allchat ──
    case 'allchat': {
      const text = commandText();
      if (!text) { await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}allchat [message]`)); break; }
      const updateProgress = await createProgressReply(asciiBox({
        title: 'ALLCHAT STARTED',
        emoji: '📣',
        rows: [['Mode', 'ALL CHAT'], ['Status', 'RUNNING']],
        footer: 'Broadcasting to all groups…',
      }));
      cmdAllChat(socket, sessionId, telegramId, text, {
        onProgress: updateProgress,
        existingPreview: quotedPreview,
        sourceExt,
      }).catch(async (error) => {
        logger.error('[EventHandler] allchat failed', { sessionId, error: String(error) });
        await updateProgress(errorCard('ALLCHAT FAILED', 'The background campaign could not finish.', String(error)));
      });
      break;
    }

    // ── join ──
    case 'join': {
      const link = args[0];
      if (!link) { await reply(warningCard('LINK REQUIRED', `Usage: ${config.prefix}join [group_link]`)); break; }
      const res = await cmdJoin(socket, link);
      await reply(res.success
        ? successCard('JOINED', `Successfully joined the group.`, [['Group', res.title ?? res.jid ?? link]])
        : errorCard('JOIN FAILED', res.error ?? 'WhatsApp rejected the join request.'));
      break;
    }

    // ── Leave current group ──
    case 'left': {
      if (!isGroup) {
        await reply(warningCard('GROUP ONLY', 'Use this command inside the group you want to leave.'));
        break;
      }
      await reply(warningCard('LEAVING', 'The account is leaving this group now.'));
      const res = await cmdLeave(socket, groupJid);
      if (!res.success) await reply(errorCard('LEAVE FAILED', res.error ?? 'WhatsApp rejected the leave request.'));
      break;
    }

    // ── leave ──
    case 'leave': {
      const target = args[0];
      if (!target) { await reply(warningCard('TARGET REQUIRED', `Usage: ${config.prefix}leave [jid/link]`)); break; }
      const res = await cmdLeave(socket, target);
      await reply(res.success
        ? successCard('LEFT GROUP', 'Successfully left the target group.')
        : errorCard('LEAVE FAILED', res.error ?? 'WhatsApp rejected the leave request.'));
      break;
    }

    // ── joinall ──
    case 'joinall': {
      const { loadBucket } = await import('../services/workspace.js');
      const links = loadBucket(telegramId, 'active').map((e) => e.link);
      if (links.length === 0) { await reply(warningCard('ACTIVE BUCKET EMPTY', 'Add links via Telegram /bucket first.')); break; }
      const updateProgress = await createProgressReply(asciiBox({
        title: 'JOINALL STARTED',
        emoji: '🔗',
        rows: [['Links', String(links.length)], ['Mode', 'RANDOMIZED']],
        footer: 'Processing in background…',
      }));
      cmdJoinAll(socket, sessionId, telegramId, links, {
        onProgress: updateProgress,
      }).catch(async (error) => { await updateProgress(errorCard('JOINALL FAILED', String(error))); });
      break;
    }

    // ── leaveall ──
    case 'leaveall': {
      const updateProgress = await createProgressReply(asciiBox({
        title: 'LEAVEALL STARTED',
        emoji: '🚪',
        rows: [['Status', 'RUNNING']],
        footer: 'Leaving all joined groups…',
      }));
      cmdLeaveAll(socket, sessionId, telegramId, {
        onProgress: updateProgress,
      }).catch(async (error) => { await updateProgress(errorCard('LEAVEALL FAILED', String(error))); });
      break;
    }

    // ── tag ──
    case 'tag': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      const text = commandText('📢');
      const res = await cmdTag(socket, sessionId, groupJid, text, { existingPreview: quotedPreview, sourceExt });
      await reply(res.success
        ? ''
        : errorCard('TAG FAILED', res.error ?? 'Could not fetch group participants.'));
      break;
    }

    // ── mtag ──
    case 'mtag': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      const text = commandText('📢');
      const res = await cmdMTag(socket, sessionId, groupJid, text, { existingPreview: quotedPreview, sourceExt });
      await reply(res.success
        ? successCard('MENTION COMPLETE', `Tagged all members in ${res.messages} message(s).`, [['Members', String(res.pinged)]])
        : errorCard('MTAG FAILED', res.error ?? 'Could not fetch group participants.'));
      break;
    }

    // ── Add links to bucket ──
    case 'addlink': {
      const links = args.filter((a) => a.includes('chat.whatsapp.com'));
      if (links.length === 0) { await reply(warningCard('VALID LINKS REQUIRED', `Usage: ${config.prefix}addlink [link1] [link2]…`)); break; }
      const result = addToMainBucket(telegramId, links);
      await reply(successCard('LINKS ADDED', 'Links saved to main bucket for validation.', [
        ['Added', String(result.added)],
        ['Duplicates skipped', String(result.dupes)],
      ]));
      break;
    }

    // ── .pair — pair a new WhatsApp session from WhatsApp ──
    case 'pair': {
      const rawPhone = args[0];
      if (!rawPhone) {
        await reply(asciiBox({
          title: 'PAIR NEW SESSION',
          emoji: '🔗',
          rows: [
            ['Usage', `${config.prefix}pair [phone]`],
            ['Example', `${config.prefix}pair +2348012345678`],
          ],
          footer: 'The new number will be paired under your account.',
        }));
        break;
      }

      let normalizedPhone: string;
      try {
        normalizedPhone = normalizePairingPhone(rawPhone);
      } catch (err) {
        await reply(errorCard('INVALID PHONE', err instanceof Error ? err.message : String(err)));
        break;
      }

      const newSessionId = `1_${telegramId}_${normalizedPhone}`;
      const existingMeta = loadSessionMeta(telegramId, newSessionId);
      if (existingMeta?.status === 'open') {
        await reply(warningCard('ALREADY CONNECTED', `A session for +${normalizedPhone} is already active.`));
        break;
      }

      const newMeta: SessionMeta = {
        ...(existingMeta ?? {
          sessionId: newSessionId,
          telegramId,
          phone: normalizedPhone,
          errorCount: 0,
          autoJoinDone: false,
        }),
        label: `WA Paired ${normalizedPhone.slice(-4)}`,
        phone: normalizedPhone,
        status: 'connecting',
        pairMethod: 'code',
        errorCount: 0,
      };

      saveSessionMeta(newMeta);
      registerSessionOwner(newSessionId, telegramId);

      await reply(asciiBox({
        title: 'PAIRING REQUESTED',
        emoji: '🔄',
        rows: [['Number', `+${normalizedPhone}`], ['Status', 'REQUESTING CODE']],
        footer: 'Pairing code incoming…',
      }));

      // Background — results are delivered back to the same WhatsApp chat
      reinitSocket(newMeta, {
        usePairingCode: true,
        phone: normalizedPhone,
        onPairingCode: async (code) => {
          try {
            await socket.sendMessage(groupJid, {
              text:
                `🔑 ${bold('Pairing code for')} +${normalizedPhone}\n\n` +
                `*${code}*\n\n` +
                `_Open WhatsApp → Linked Devices → Link with phone number → Enter code above._`,
            });
          } catch { /* ignore */ }
        },
        onPairingError: async (error) => {
          try {
            await socket.sendMessage(groupJid, {
              text: errorCard('PAIRING FAILED', `Could not pair +${normalizedPhone}.`, error.message),
            });
          } catch { /* ignore */ }
        },
        onConnected: async () => {
          try {
            await socket.sendMessage(groupJid, {
              text: successCard('SESSION CONNECTED', `+${normalizedPhone} is now active under your account.`, [
                ['Session ID', newSessionId],
              ]),
            });
          } catch { /* ignore */ }
        },
      }).catch(async (err) => {
        try {
          await socket.sendMessage(groupJid, { text: errorCard('PAIRING ERROR', String(err)) });
        } catch { /* ignore */ }
      });

      break;
    }
  }
}

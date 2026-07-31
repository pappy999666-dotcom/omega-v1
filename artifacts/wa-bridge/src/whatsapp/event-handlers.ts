// ============================================================
// WA-Bridge — WhatsApp Event Handler
// Processes incoming messages, dispatches commands.
// ALL outgoing responses pass through the centralized
// PreviewManager — the single source of truth for previews.
// ============================================================

import type { BridgeWASocket as WASocket, BaileysEventMap, IMessage, WebMessageInfo } from './baileys-types.js';
import { resolvePreviewRoute } from './preview-router.js';
import { parseCommand, parseStickerCommand, hashSticker } from './command-parser.js';
import { resolveTarget, resolveTargetNumbers } from './utils/resolve-target.js';
import { loadSessionConfig, loadSessionMeta, updateSessionMeta, saveSessionMeta, getGlobalMenuUrl } from '../services/workspace.js';
import { stopSpamLoop, isSpamLoopActive, cmdToChat, cmdToChatX, cmdSStatus, cmdGroupStatus } from './commands/status.js';
import { cmdAllStatus, cmdAllGStatus, stopAllStatus, isAllStatusRunning } from './commands/all-status.js';
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
import { ALL_COMMANDS } from './command-parser.js';
import { buildMenuSections, buildGroupMenuSections } from './menu-registry.js';
// ── Anti System ───────────────────────────────────────────
import { runAntiChecks, handleParticipantUpdate } from './anti-system/index.js';
import {
  handleAntiCommand,
  handlePermitCommand,
  handleSpamlimit,
  handleAntiMsg,
  handleAntiAddWord,
  handleAntiRemoveWord,
  handleAntiWordList,
  handleAntiDemote,
  handleAntiStatus,
} from './anti-system/commands.js';
// ── Group Moderation Commands ─────────────────────────────
import {
  cmdKick,
  cmdBan,
  cmdUnban,
  cmdBanList,
  cmdPromote,
  cmdDemote,
  cmdDnKick,
  cmdWarn,
  cmdUnwarn,
  cmdWarnCount,
  cmdPoll,
  cmdBlockAll,
  cmdBlock,
  cmdDeleteAll,
  cmdMute,
  cmdUnmute,
  cmdSetWelcome,
  cmdWelcomeToggle,
  cmdSetGoodbye,
  cmdGoodbyeToggle,
  cmdSetModerationMsg,
  cmdEventStatus,
} from './commands/group-moderation.js';
import { setAutoblockConfig } from '../services/group-config.js';
import { fetchGroupMeta, resolveRealJidFromMeta } from './utils/group-permissions.js';
import { parseUrlButtons, sendWithUrlButtons } from './utils/url-buttons.js';
import fs from 'fs';
import path from 'path';
import { sessionDir } from '../services/workspace.js';

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


// ── Main Event Router ─────────────────────────────────────

export async function handleWAEvent(
  sessionId: string,
  event: keyof BaileysEventMap,
  data: unknown,
  socket: WASocket
): Promise<void> {
  if (event === 'messages.upsert') {
    await handleMessages(sessionId, data as { messages: WebMessageInfo[]; type: string }, socket);
    return;
  }

  // ── Anti System: group participant events (AntiPromote / AntiDemote / Welcome / Goodbye) ──
  if (event === 'group-participants.update') {
    const telegramId = sessionOwnerMap.get(sessionId);
    if (telegramId) {
      // Baileys emits group-participants.update as an ARRAY of update objects.
      // Casting to a single object was the root cause of Welcome/Goodbye never firing.
      const rawUpdates = data as unknown;
      const updates: Array<{ id: string; participants: string[]; action: string; author?: string }> =
        Array.isArray(rawUpdates)
          ? (rawUpdates as Array<{ id: string; participants: string[]; action: string; author?: string }>)
          : [rawUpdates as { id: string; participants: string[]; action: string; author?: string }];

      for (const update of updates) {
        if (!update?.id) continue;
        await handleParticipantUpdate(socket, sessionId, telegramId, {
          id: update.id,
          participants: update.participants ?? [],
          action: update.action as 'add' | 'remove' | 'promote' | 'demote',
          author: update.author,
        }).catch((err) => {
          logger.warn('[AntiSystem] handleParticipantUpdate error', { err: String(err) });
        });
      }
    }
    return;
  }
}

/** Execute command text without sending that command into any WhatsApp chat. */
export async function executeBridgeCommand(
  sessionId: string,
  telegramId: string,
  text: string,
  socket: WASocket,
  onReply: (text: string) => Promise<void>,
  opts?: { forcePrefix?: string }
): Promise<void> {
  if (loadSessionConfig(telegramId, sessionId).sleeping) throw new Error('User sleep mode is active');

  // Normalize to forced prefix (dot) so Omni/Global bridge always works
  // regardless of what prefix the session owner configured on WhatsApp.
  let normalizedText = text;
  if (opts?.forcePrefix) {
    const fp = opts.forcePrefix;
    if (!text.startsWith(fp)) {
      // Strip any existing prefix char(s) then prepend the forced one
      normalizedText = fp + text.replace(/^[^a-zA-Z0-9]+/, '');
    }
  }

  const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? `${telegramId}@s.whatsapp.net`;
  const syntheticMessage = {
    key: { remoteJid: ownJid, fromMe: true, id: `bridge-${Date.now()}` },
    message: { conversation: normalizedText },
  } as WebMessageInfo;

  // If forcePrefix is set, temporarily override the session config prefix
  // so parseCommand matches correctly.
  if (opts?.forcePrefix) {
    const origConfig = loadSessionConfig(telegramId, sessionId);
    const patchedConfig = { ...origConfig, prefix: opts.forcePrefix, nullPrefix: false };
    await processMessageWithConfig(sessionId, telegramId, syntheticMessage, socket, onReply, patchedConfig);
  } else {
    await processMessage(sessionId, telegramId, syntheticMessage, socket, onReply);
  }
}

/**
 * Execute a command text within the context of a specific WhatsApp group.
 * Sets remoteJid = gcJid so isGroup=true — all group management commands
 * (kick, promote, demote, antilink, welcomemsg, etc.) work correctly.
 */
export async function executeGroupBridgeCommand(
  sessionId: string,
  telegramId: string,
  text: string,
  gcJid: string,
  socket: WASocket,
  onReply: (text: string) => Promise<void>
): Promise<void> {
  if (loadSessionConfig(telegramId, sessionId).sleeping) throw new Error('User sleep mode is active');

  const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? `${telegramId}@s.whatsapp.net`;
  const syntheticMessage = {
    key: {
      remoteJid: gcJid,       // group JID → isGroup=true in processMessage
      fromMe: true,
      id: `gc-bridge-${Date.now()}`,
      participant: ownJid,    // required for group message ownership
    },
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

    // ── Anti System: run BEFORE command dispatch ──────────────
    // Non-throwing; errors in anti modules are isolated internally.
    try {
      const triggered = await runAntiChecks(socket, msg, sessionId, telegramId);
      if (triggered) continue; // skip command parsing for violated messages
    } catch (err) {
      logger.warn('[AntiSystem] runAntiChecks threw', { err: String(err) });
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
  return processMessageWithConfig(sessionId, telegramId, msg, socket, replyOverride, undefined);
}

async function processMessageWithConfig(
  sessionId: string,
  telegramId: string,
  msg: WebMessageInfo,
  socket: WASocket,
  replyOverride?: (text: string) => Promise<void>,
  configOverride?: ReturnType<typeof loadSessionConfig>
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

  // Extract sticker for macro matching
  const stickerMsg = msg.message?.stickerMessage;

  // As-is relay: detect sourceExt for chat commands (static import — no dynamic overhead)
  const chatRoute = resolvePreviewRoute(msg, text);
  const sourceExt = chatRoute.route === 'AS_IS' ? chatRoute.sourceExt : undefined;

  const config = configOverride ?? loadSessionConfig(telegramId, sessionId);
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
    // fileSha256 can be Uint8Array or base64 string depending on Baileys version
    parsed = parseStickerCommand(stickerMsg.fileSha256 as unknown as Buffer, config);
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
  // Central URL button attachment for all normal bot responses.
  const baseWhatsAppReply = async (replyText: string): Promise<void> => {
    const mentions = await getGroupParticipants();
    let visibleText = replyText;
    const buttons = parseUrlButtons(getGlobalMenuUrl());
    for (const button of buttons) {
      if (visibleText.includes(button.url)) {
        visibleText = visibleText.replace(button.url, '').replace(/\n\s*\n/g, '\n').trim();
      }
    }

    const sentWithButtons = await sendWithUrlButtons(
      socket,
      groupJid,
      { text: visibleText, ...(mentions.length > 0 ? { mentions } : {}) },
      buttons,
      { quoted: msg }
    );
    if (sentWithButtons) return;

    await PreviewManager.send(socket as any, groupJid, visibleText, {
      quoted: msg,
      extra: mentions.length > 0 ? { mentions } : undefined,
    });
  };

  const reply = replyOverride ?? baseWhatsAppReply;

  type MediaKind = 'image' | 'video' | 'audio';
  type ExtractedMedia = { buffer: Buffer; type: MediaKind; mimeType: string; ptt?: boolean; caption?: string };
  const anyMessage = (msg.message ?? {}) as Record<string, any>;
  const getContextInfo = (): any => anyMessage.extendedTextMessage?.contextInfo
    ?? anyMessage.imageMessage?.contextInfo
    ?? anyMessage.videoMessage?.contextInfo
    ?? anyMessage.stickerMessage?.contextInfo
    ?? anyMessage.audioMessage?.contextInfo
    ?? null;
  const unwrapMessage = (message: any): any => message?.ephemeralMessage?.message
    ?? message?.viewOnceMessage?.message
    ?? message?.viewOnceMessageV2?.message
    ?? message?.documentWithCaptionMessage?.message
    ?? message;
  const extractStickerId = (): string | null => {
    const quoted = unwrapMessage(getContextInfo()?.quotedMessage);
    const sticker = quoted?.stickerMessage ?? anyMessage.stickerMessage;
    const sha = sticker?.fileSha256;
    return sha ? hashSticker(sha as Buffer | Uint8Array | string) : null;
  };
  const downloadMessageMedia = async (source: WebMessageInfo): Promise<Buffer | null> => {
    try {
      const baileys = await import('@crysnovax/baileys') as Record<string, any>;
      const fn = baileys.downloadMediaMessage as ((m: unknown, type: string, opts: unknown) => Promise<Buffer>) | undefined;
      if (!fn) return null;
      return await fn(source, 'buffer', {});
    } catch (err) {
      logger.warn('[Media] download failed', { err: String(err) });
      return null;
    }
  };
  const extractMedia = async (): Promise<ExtractedMedia | null> => {
    const direct = unwrapMessage(msg.message as any);
    const quoted = unwrapMessage(getContextInfo()?.quotedMessage);
    const sourceMessage = quoted ? ({ key: msg.key, message: quoted } as WebMessageInfo) : msg;
    const m = quoted ?? direct;
    const mediaNode = m?.imageMessage ? { type: 'image' as const, node: m.imageMessage }
      : m?.videoMessage ? { type: 'video' as const, node: m.videoMessage }
      : m?.audioMessage ? { type: 'audio' as const, node: m.audioMessage }
      : null;
    if (!mediaNode) return null;
    const buffer = await downloadMessageMedia(sourceMessage);
    if (!buffer) return null;
    return {
      buffer,
      type: mediaNode.type,
      mimeType: mediaNode.node?.mimetype ?? (mediaNode.type === 'audio' ? 'audio/mp4' : mediaNode.type === 'video' ? 'video/mp4' : 'image/jpeg'),
      ptt: Boolean(mediaNode.node?.ptt),
      caption: mediaNode.node?.caption,
    };
  };
  const sendMenuResponse = async (title: string, body: string): Promise<void> => {
    const meta = loadSessionMeta(telegramId, sessionId);
    const media = meta?.menuMedia;
    const buttons = parseUrlButtons(getGlobalMenuUrl());
    if (media?.filePath && fs.existsSync(media.filePath)) {
      const content = media.type === 'video'
        ? { video: fs.readFileSync(media.filePath), caption: body, mimetype: media.mimeType }
        : { image: fs.readFileSync(media.filePath), caption: body, mimetype: media.mimeType };
      if (await sendWithUrlButtons(socket, groupJid, content, buttons, { quoted: msg })) return;
      await socket.sendMessage(groupJid, content, { quoted: msg });
      return;
    }
    await reply(body);
  };

  const createProgressReply = async (initialText: string): Promise<(nextText: string) => Promise<void>> => {
    if (replyOverride) {
      // Telegram bridge: send one message then edit it for live updates
      // replyOverride is ctx.reply — we need editMessageText, so we use a shared ref
      const wrap = (t: string) => `<blockquote expandable>${t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</blockquote>`;
      await replyOverride(wrap(initialText));
      // Can't edit via replyOverride alone — send final result only to avoid spam
      let lastSent = Date.now();
      return async (nextText: string) => {
        const isFinal = /COMPLETE|FAILED|DONE|HALTED/i.test(nextText);
        if (isFinal || Date.now() - lastSent > 4000) {
          lastSent = Date.now();
          await replyOverride(wrap(nextText));
        }
      };
    }
    const sent = await socket.sendMessage(groupJid, { text: initialText }, { quoted: msg }) as { key?: import("@crysnovax/baileys").WAMessageKey } | undefined;
    const key = sent?.key;
    return async (nextText: string) => {
      if (!key) { await socket.sendMessage(groupJid, { text: nextText }); return; }
      try { await socket.sendMessage(groupJid, { text: nextText, edit: key }); }
      catch { await socket.sendMessage(groupJid, { text: nextText }); }
    };
  };
  const commandText = (fallback = ''): string => args.join(' ').trim() || quotedText.trim() || fallback;

  // ── Resolve sender JID — fix LID → real JID so sudo matching works ──
  let rawSenderJid = msg.key.participant ?? (msg.key.fromMe ? (socket as { user?: { id?: string } }).user?.id : msg.key.remoteJid);
  let senderPhoneOverride: string | undefined;
  if (rawSenderJid?.endsWith('@lid') && isGroup) {
    try {
      const { fetchGroupMeta: _fgm, bestRealJid: _brj } = await import('./utils/group-permissions.js');
      const _meta = await _fgm(socket, groupJid);
      if (_meta) {
        const resolved = _brj(_meta.participants, rawSenderJid);
        if (!resolved.endsWith('@lid')) {
          rawSenderJid = resolved;
        } else {
          // Still @lid — extract phoneNumber from participant entry directly
          const lidNum = (rawSenderJid.split('@')[0] ?? '').split(':')[0] ?? '';
          const participant = _meta.participants.find(
            p => (p.id.split('@')[0] ?? '').split(':')[0] === lidNum
          );
          if (participant?.phoneNumber) {
            senderPhoneOverride = participant.phoneNumber.replace(/\D/g, '');
          }
        }
      }
    } catch { /* non-critical */ }
  }
  const senderJid = rawSenderJid;

  const isOwnerSender = Boolean(msg.key.fromMe);
  // For unresolved LIDs, check sudo via phoneNumber override
  const sudoCheckJid = senderPhoneOverride ? `${senderPhoneOverride}@s.whatsapp.net` : senderJid;
  if (!replyOverride && !isAuthorizedCommandSender(isOwnerSender, sudoCheckJid, config.sudoNumbers)) {
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

    // ── Menu (general commands) ──
    case 'menu':
    case 'help': {
      await sendMenuResponse('WA-BRIDGE CONTROL', whatsappMenu('WA-BRIDGE CONTROL', buildMenuSections(config.prefix, ALL_COMMANDS)));
      break;
    }

    // ── Group Menu (moderation + anti system) ──
    case 'gmenu': {
      await sendMenuResponse('GROUP TOOLS', whatsappMenu('GROUP TOOLS', buildGroupMenuSections(config.prefix, ALL_COMMANDS)));
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
      const quotedStickerHash = extractStickerId() ?? undefined;

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
      // Use a temporary dot prefix for validation so empty-prefix sessions still work
      const testPrefix = config.prefix || '.';
      const parsedBinding = boundCmd ? parseCommand(`${testPrefix}${boundCmd}`, {
        ...config,
        prefix: testPrefix,
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

    // ── Menu Media ──
    case 'setmenupic':
    case 'setmenuvideo': {
      const media = await extractMedia();
      const expected = command === 'setmenupic' ? 'image' : 'video';
      if (!media || media.type !== expected) {
        await reply(warningCard('REPLY TO MEDIA', `Reply to a ${expected} with ${config.prefix}${command}.`));
        break;
      }
      const dir = path.join(sessionDir(telegramId, sessionId), 'menu-media');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `menu.${expected === 'image' ? 'jpg' : 'mp4'}`);
      fs.writeFileSync(filePath, media.buffer);
      updateSessionMeta(telegramId, sessionId, { menuMedia: { type: expected, filePath, mimeType: media.mimeType } });
      await reply(successCard('MENU MEDIA SET', `Menus will now render with this ${expected}.`));
      break;
    }
    case 'delmenumedia': {
      updateSessionMeta(telegramId, sessionId, { menuMedia: null });
      await reply(successCard('MENU MEDIA REMOVED', 'Menus restored to the default text-only layout.'));
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
      let targets = resolveTargetNumbers(args, msg);

      // If reply-based and result looks like a LID (no leading country code pattern),
      // try to resolve via group participant phoneNumber field
      if (targets.length > 0 && isGroup) {
        const ci = msg.message?.extendedTextMessage?.contextInfo;
        if (ci?.participant?.endsWith('@lid')) {
          try {
            const gm = await fetchGroupMeta(socket, groupJid);
            if (gm) {
              const lidNum = (ci.participant.split('@')[0] ?? '').split(':')[0] ?? '';
              const member = gm.participants.find(
                p => (p.id.split('@')[0] ?? '').split(':')[0] === lidNum
              );
              if (member?.phoneNumber) {
                targets = [member.phoneNumber.replace(/\D/g, '')];
              } else if (!member?.id.endsWith('@lid')) {
                targets = [(member?.id.split('@')[0] ?? '').split(':')[0] ?? targets[0]!];
              }
            }
          } catch { /* non-critical */ }
        }
      }

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

    // ── User Info ──
    case 'userinfo':
    case 'getinfo': {
      // If no target given, show info about the sender
      const infoTarget = await resolveTarget(args, msg, socket, isGroup ? groupJid : undefined);
      const subjectJid = infoTarget?.jid
        ?? senderJid
        ?? `${normalizeWhatsAppNumber(senderJid)}@s.whatsapp.net`;
      const subjectNumber = infoTarget?.number ?? normalizeWhatsAppNumber(subjectJid);

      let profilePicUrl: string | undefined;
      let bio = 'Not set';
      try {
        profilePicUrl = await (socket as unknown as { profilePictureUrl(jid: string, type: string): Promise<string | undefined> })
          .profilePictureUrl(subjectJid, 'image');
      } catch { /* private or not available */ }
      try {
        const status = await (socket as unknown as { fetchStatus(jid: string): Promise<{ status?: string } | null | undefined> })
          .fetchStatus(subjectJid);
        bio = status?.status ?? 'Not set';
      } catch { /* private or not available */ }

      const infoRows: [string, string][] = [
        ['Number', `+${subjectNumber}`],
        ['JID', subjectJid],
        ['Bio', bio.slice(0, 80)],
        ['Profile Pic', profilePicUrl ? '✅ Attached below' : '❌ Private / Not set'],
      ];
      if (infoTarget?.lid) {
        infoRows.push(['LID', infoTarget.lid]);
      }
      if (!infoTarget) {
        infoRows.unshift(['Display Name', msg.pushName ?? 'Unknown']);
      }

      await reply(asciiBox({
        title: 'USER INFO',
        emoji: '👤',
        rows: infoRows,
        footer: infoTarget
          ? `JID is always used for actions — LID shown separately when available.`
          : 'Your own session identity',
      }));

      // Send profile picture as image if available
      if (profilePicUrl) {
        try {
          await (socket as unknown as {
            sendMessage(jid: string, content: Record<string, unknown>, opts?: Record<string, unknown>): Promise<unknown>;
          }).sendMessage(groupJid, {
            image: { url: profilePicUrl },
            caption: `📸 Profile picture for +${subjectNumber}`,
          });
        } catch (picErr) {
          logger.warn('[GetInfo] Failed to send profile picture', { err: String(picErr), subjectJid });
        }
      }
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
      const media = command === 'smedia' ? await extractMedia() : null;
      const text = commandText() || media?.caption || '';
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Run this command inside a WhatsApp group.')); break; }
      if (!text && !media) { await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}gstatus [message], or reply to media/text.`)); break; }
      const sent = await cmdGroupStatus(socket, sessionId, groupJid, text, {
        theme: config.statusDesignTheme,
        existingPreview: quotedPreview,
        sourceMsg: msg,
        ...(media ? { mediaBuffer: media.buffer, mediaType: media.type, caption: text, ptt: media.ptt, mimeType: media.mimeType } : {}),
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
      const allStatusMedia = await extractMedia();
      const text = commandText() || allStatusMedia?.caption || '';
      if (!text && !allStatusMedia) {
        await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}${command}${command.endsWith('x') ? ' <count>' : ''} <message or reply to media>`));
        break;
      }
      await reply(asciiBox({ title: 'BROADCAST STARTED', emoji: '📡', rows: [['Repeats', String(repeat)], ['Mode', 'ALL STATUS']], footer: 'Running in background…' }));
      void (async () => {
        for (let index = 0; index < repeat; index += 1) {
          await cmdAllStatus(socket, sessionId, telegramId, text, {
            existingPreview: quotedPreview,
            sourceExt,
            ...(allStatusMedia ? {
              mediaBuffer: allStatusMedia.buffer,
              mediaType: allStatusMedia.type,
              caption: text || allStatusMedia.caption,
              mimeType: allStatusMedia.mimeType,
              ptt: allStatusMedia.ptt,
            } : {}),
          });
        }
        await socket.sendMessage(groupJid, { text: asciiBox({ title: 'BROADCAST COMPLETE', emoji: '✅', rows: [['Repeats', String(repeat)], ['Mode', 'ALL STATUS']] }) });
      })().catch(async (error) => {
        logger.error('[EventHandler] allstatus failed', { sessionId, error: String(error) });
        await socket.sendMessage(groupJid, { text: errorCard('BROADCAST FAILED', String(error)) });
      });
      break;
    }

    // ── allgstatus (raw — no design engine) ──
    case 'allgstatus': {
      const agText = commandText();
      if (!agText) { await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}allgstatus <message or link>`)); break; }
      await reply(asciiBox({ title: 'ALLGSTATUS STARTED', emoji: '📡', rows: [['Mode', 'RAW — NO DESIGN']], footer: 'Running in background…' }));
      void cmdAllGStatus(socket, sessionId, telegramId, agText, { existingPreview: quotedPreview, sourceExt })
        .then(async (r) => {
          await socket.sendMessage(groupJid, { text: asciiBox({ title: 'ALLGSTATUS COMPLETE', emoji: '✅', rows: [['Sent', String(r.success)], ['Failed', String(r.failed)], ['Skipped', String(r.skipped)]] }) });
        })
        .catch(async (err) => {
          await socket.sendMessage(groupJid, { text: errorCard('ALLGSTATUS FAILED', String(err)) });
        });
      break;
    }

    // ── allgstatus (raw — no design engine) ──
    case 'allgstatus': {
      const agText = commandText();
      if (!agText) { await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}allgstatus <message or link>`)); break; }
      await reply(asciiBox({ title: 'ALLGSTATUS STARTED', emoji: '📡', rows: [['Mode', 'RAW — NO DESIGN']], footer: 'Running in background…' }));
      void cmdAllGStatus(socket, sessionId, telegramId, agText, { existingPreview: quotedPreview, sourceExt })
        .then(async (r) => {
          await socket.sendMessage(groupJid, { text: asciiBox({ title: 'ALLGSTATUS COMPLETE', emoji: '✅', rows: [['Sent', String(r.success)], ['Failed', String(r.failed)], ['Skipped', String(r.skipped)]] }) });
        })
        .catch(async (err) => {
          await socket.sendMessage(groupJid, { text: errorCard('ALLGSTATUS FAILED', String(err)) });
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
      const { stopJoinAll, clearJoinAllStop, isJoinAllStopped } = await import('../services/join-manager.js');
      const links = loadBucket(telegramId, 'active').map((e) => e.link);
      if (links.length === 0) { await reply(warningCard('ACTIVE BUCKET EMPTY', 'Add links via Telegram /bucket first.')); break; }
      clearJoinAllStop(sessionId);
      await reply(asciiBox({ title: 'JOINALL STARTED', emoji: '🔗', rows: [['Links', String(links.length)]], footer: `Use ${config.prefix}stopjoin to stop.` }));
      cmdJoinAll(socket, sessionId, telegramId, links, {}).then(async (res) => {
        await socket.sendMessage(groupJid, { text: asciiBox({
          title: 'JOINALL COMPLETE', emoji: '✅',
          rows: [['Joined', String(res.success)], ['Failed', String(res.failed)], ['Skipped', String(res.skipped)]],
        }) });
      }).catch(async (error) => {
        await socket.sendMessage(groupJid, { text: errorCard('JOINALL FAILED', String(error)) });
      });
      break;
    }

    // ── stopjoin ──
    case 'stopjoin': {
      const { stopJoinAll } = await import('../services/join-manager.js');
      stopJoinAll(sessionId);
      await reply(successCard('JOINALL STOPPED', 'The join operation will stop after the current attempt.'));
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

    // ──────────────────────────────────────────────────────────
    // ◈ ANTI SYSTEM — Group Moderation Engine
    // ──────────────────────────────────────────────────────────

    // ── Anti System Overview ──
    case 'antistatus': {
      await reply(handleAntiStatus(telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiLink ──
    case 'antilink': {
      await reply(handleAntiCommand('antilink', 'antilink', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'linkpermit': {
      await reply(handlePermitCommand('antilink', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmlinkpermit': {
      await reply(handlePermitCommand('antilink', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'antilinkmsg': {
      await reply(handleAntiMsg('antilink', args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiBot ──
    case 'antibot': {
      await reply(handleAntiCommand('antibot', 'antibot', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'botpermit': {
      await reply(handlePermitCommand('antibot', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmbotpermit': {
      await reply(handlePermitCommand('antibot', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiSpam ──
    case 'antispam': {
      await reply(handleAntiCommand('antispam', 'antispam', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'spamlimit': {
      await reply(handleSpamlimit(args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'spampermit': {
      await reply(handlePermitCommand('antispam', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmspampermit': {
      await reply(handlePermitCommand('antispam', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'antispammsg': {
      await reply(handleAntiMsg('antispam', args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiPic ──
    case 'antipic': {
      await reply(handleAntiCommand('antipic', 'antipic', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'picpermit': {
      await reply(handlePermitCommand('antipic', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmpicpermit': {
      await reply(handlePermitCommand('antipic', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiVid ──
    case 'antivid': {
      await reply(handleAntiCommand('antivid', 'antivid', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'vidpermit': {
      await reply(handlePermitCommand('antivid', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmvidpermit': {
      await reply(handlePermitCommand('antivid', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiAud ──
    case 'antiaud': {
      await reply(handleAntiCommand('antiaud', 'antiaud', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'audpermit': {
      await reply(handlePermitCommand('antiaud', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmaudpermit': {
      await reply(handlePermitCommand('antiaud', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiVN ──
    case 'antivn': {
      await reply(handleAntiCommand('antivn', 'antivn', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'vnpermit': {
      await reply(handlePermitCommand('antivn', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmvnpermit': {
      await reply(handlePermitCommand('antivn', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'antivnmsg': {
      await reply(handleAntiMsg('antivn', args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiText ──
    case 'antitxt': {
      await reply(handleAntiCommand('antitxt', 'antitxt', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    // ── AntiEmoji ──
    case 'antiemoji': {
      await reply(handleAntiCommand('antiemoji', 'antiemoji', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'emojipermit': {
      await reply(handlePermitCommand('antiemoji', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmemojipermit': {
      await reply(handlePermitCommand('antiemoji', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'antiemojimsg': {
      await reply(handleAntiMsg('antiemoji', args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiSticker ──
    case 'antisticker': {
      await reply(handleAntiCommand('antisticker', 'antisticker', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'sticpermit': {
      await reply(handlePermitCommand('antisticker', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmsticpermit': {
      await reply(handlePermitCommand('antisticker', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiGroupCall ──
    case 'antigroupcall': {
      await reply(handleAntiCommand('antigroupcall', 'antigroupcall', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    // ── AntiNSFW ──
    case 'antinsfw': {
      await reply(handleAntiCommand('antinsfw', 'antinsfw', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'nsfwpermit': {
      await reply(handlePermitCommand('antinsfw', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmnsfwpermit': {
      await reply(handlePermitCommand('antinsfw', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiGroupMention ──
    case 'antigroupmention': {
      await reply(handleAntiCommand('antigroupmention', 'antigroupmention', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'mentionpermit': {
      await reply(handlePermitCommand('antigroupmention', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmmentionpermit': {
      await reply(handlePermitCommand('antigroupmention', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiGM (Status Group Mentions) ──
    case 'antigm': {
      await reply(handleAntiCommand('antigm', 'antigm', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'gmpermit': {
      await reply(handlePermitCommand('antigm', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmgmpermit': {
      await reply(handlePermitCommand('antigm', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiWords ──
    case 'antiwords': {
      await reply(handleAntiCommand('antiwords', 'antiwords', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'antiaddword': {
      await reply(handleAntiAddWord(args, telegramId, sessionId, groupJid));
      break;
    }
    case 'antirmword': {
      await reply(handleAntiRemoveWord(args, telegramId, sessionId, groupJid));
      break;
    }
    case 'antiwordlist': {
      await reply(handleAntiWordList(telegramId, sessionId, groupJid));
      break;
    }
    case 'antiwordsmsg': {
      await reply(handleAntiMsg('antiwords', args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiPoll ──
    case 'antipoll': {
      await reply(handleAntiCommand('antipoll', 'antipoll', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'pollpermit': {
      await reply(handlePermitCommand('antipoll', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmpollpermit': {
      await reply(handlePermitCommand('antipoll', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiForward ──
    case 'antiforward': {
      await reply(handleAntiCommand('antiforward', 'antiforward', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'fwdpermit': {
      await reply(handlePermitCommand('antiforward', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmfwdpermit': {
      await reply(handlePermitCommand('antiforward', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiChannel ──
    case 'antichannel': {
      await reply(handleAntiCommand('antichannel', 'antichannel', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'chanpermit': {
      await reply(handlePermitCommand('antichannel', true, args, msg, telegramId, sessionId, groupJid));
      break;
    }
    case 'rmchanpermit': {
      await reply(handlePermitCommand('antichannel', false, args, msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── AntiPromote ──
    case 'antipromote': {
      await reply(handleAntiCommand('antipromote', 'antipromote', args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    // ── AntiDemote ──
    case 'antidemote': {
      await reply(handleAntiDemote(args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    // ──────────────────────────────────────────────────────────

    // ──────────────────────────────────────────────────────────
    // ◈ GROUP MODERATION COMMANDS
    // All require groupJid.endsWith('@g.us') — enforced inside each handler
    // ──────────────────────────────────────────────────────────

    case 'kick':
    case 'remove': {
      await reply(await cmdKick(args, msg, socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'ban': {
      await reply(await cmdBan(args, msg, socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'block': {
      await reply(await cmdBlock(args, msg, socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'deleteall': {
      await reply(await cmdDeleteAll(args, msg, socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'dnkick': {
      await reply(await cmdDnKick(args, msg, socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'unban': {
      await reply(cmdUnban(args, msg, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'banlist': {
      await reply(cmdBanList(telegramId, sessionId, groupJid));
      break;
    }

    case 'promote': {
      await reply(await cmdPromote(args, msg, socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'demote': {
      await reply(await cmdDemote(args, msg, socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'warn': {
      await reply(await cmdWarn(args, msg, socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'unwarn':
    case 'resetwarn': {
      await reply(cmdUnwarn(args, msg, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'warns': {
      await reply(cmdWarnCount(args, msg, sessionId, groupJid, config.prefix));
      break;
    }

    case 'poll': {
      await reply(await cmdPoll(args, msg, socket, groupJid, config.prefix));
      break;
    }

    // ── Welcome / Goodbye ──
    case 'setwelcome':
    case 'welcomemsg': {
      await reply(cmdSetWelcome(args, msg, telegramId, sessionId, groupJid));
      break;
    }

    case 'welcome': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') { await reply(cmdWelcomeToggle(true, telegramId, sessionId, groupJid)); break; }
      if (sub === 'off') { await reply(cmdWelcomeToggle(false, telegramId, sessionId, groupJid)); break; }
      await reply(cmdSetWelcome(args.slice(1), msg, telegramId, sessionId, groupJid));
      break;
    }

    case 'setgoodbye':
    case 'goodbyemsg': {
      await reply(cmdSetGoodbye(args, msg, telegramId, sessionId, groupJid));
      break;
    }

    case 'goodbye': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') { await reply(cmdGoodbyeToggle(true, telegramId, sessionId, groupJid)); break; }
      if (sub === 'off') { await reply(cmdGoodbyeToggle(false, telegramId, sessionId, groupJid)); break; }
      await reply(cmdSetGoodbye(args.slice(1), msg, telegramId, sessionId, groupJid));
      break;
    }

    // ── Moderation Response Templates ──
    case 'kickmsg': {
      await reply(cmdSetModerationMsg('kick', 'Kick', args, msg, telegramId, sessionId, groupJid));
      break;
    }

    case 'warnmsg': {
      await reply(cmdSetModerationMsg('warn', 'Warn', args, msg, telegramId, sessionId, groupJid));
      break;
    }

    case 'banmsg': {
      await reply(cmdSetModerationMsg('ban', 'Ban', args, msg, telegramId, sessionId, groupJid));
      break;
    }

    case 'unbanmsg': {
      await reply(cmdSetModerationMsg('unban', 'Unban', args, msg, telegramId, sessionId, groupJid));
      break;
    }

    case 'eventstatus': {
      await reply(cmdEventStatus(telegramId, sessionId, groupJid));
      break;
    }

    // ── Mute / Unmute ──
    case 'mute': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      await reply(await cmdMute(socket, groupJid, config.prefix));
      break;
    }

    case 'unmute': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      await reply(await cmdUnmute(socket, groupJid, config.prefix));
      break;
    }

    // ── BlockAll ──
    case 'blockall': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      await reply(asciiBox({ title: '🚫 BlockAll — Starting…', emoji: '⏳', rows: [['Status', 'Fetching group members…']] }));
      const result = await cmdBlockAll(
        socket, telegramId, sessionId, groupJid, config.sudoNumbers ?? [],
        // No live progress on WhatsApp — send one final result
      );
      await reply(result);
      break;
    }

    // ── AutoBlock ──
    case 'autoblock': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') {
        // Verify bot is admin before enabling
        const abMeta = await fetchGroupMeta(socket, groupJid).catch(() => null);
        if (!abMeta?.botIsAdmin) {
          await reply(errorCard('AutoBlock', 'I need to be a group admin to use AutoBlock.\nPromote me and try again.'));
          break;
        }
        setAutoblockConfig(telegramId, sessionId, groupJid, true);
        await reply(successCard('AutoBlock ON', 'Every new member who joins this group will be automatically blocked.\nProtected users (admins, sudo) are always exempt.'));
        break;
      }
      if (sub === 'off') {
        setAutoblockConfig(telegramId, sessionId, groupJid, false);
        await reply(successCard('AutoBlock OFF', 'New members will no longer be automatically blocked.'));
        break;
      }
      await reply(asciiBox({
        title: 'AutoBlock',
        emoji: '🚫',
        rows: [
          ['Usage', `${config.prefix}autoblock on`],
          ['', `${config.prefix}autoblock off`],
          ['Description', 'Blocks every new member who joins the group'],
          ['Exempt', 'Admins, group owner, bot, sudo users'],
        ],
      }));
      break;
    }

    // ── Join Approval — WhatsApp-side commands ──
    // These mirror the Telegram per-group dashboard approval features.
    // All require the bot to be a group admin.

    case 'pendingjoin': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      try {
        const sock = socket as unknown as {
          groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string; phoneNumber?: string }>>;
        };
        const pending = await sock.groupRequestParticipantsList(groupJid);
        if (pending.length === 0) {
          await reply(warningCard('NO PENDING REQUESTS', 'There are currently no pending join requests for this group.'));
          break;
        }
        await reply(asciiBox({
          title: 'PENDING JOIN REQUESTS',
          emoji: '🚪',
          rows: [
            ['Total', String(pending.length)],
            ...pending.slice(0, 10).map((r, i): [string, string] => [
              `#${i + 1}`,
              `+${(r.phoneNumber ?? r.jid.split('@')[0] ?? '').replace(/[^0-9]/g, '')}`,
            ]),
            ...(pending.length > 10 ? [['…', `+${pending.length - 10} more`] as [string, string]] : []),
          ],
          footer: `Use ${config.prefix}approveall, ${config.prefix}approveamt <n>, or ${config.prefix}approvecountry <code>`,
        }));
      } catch (err) {
        await reply(errorCard('PENDING REQUESTS FAILED', 'Could not fetch join requests. Make sure the bot is an admin.', String(err)));
      }
      break;
    }

    case 'approveall': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      const meta_aa = await fetchGroupMeta(socket, groupJid);
      if (!meta_aa?.botIsAdmin) { await reply(errorCard('APPROVE ALL', 'I need to be a group admin to manage join requests.')); break; }
      try {
        const sock = socket as unknown as {
          groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string }>>;
          groupRequestParticipantsUpdate(jid: string, p: string[], action: 'approve' | 'reject'): Promise<unknown>;
        };
        const pending_aa = await sock.groupRequestParticipantsList(groupJid);
        if (pending_aa.length === 0) {
          await reply(warningCard('NOTHING TO APPROVE', 'No pending join requests found.')); break;
        }
        const updateProgress_aa = await createProgressReply(asciiBox({
          title: 'APPROVE ALL — RUNNING',
          emoji: '✅',
          rows: [['Pending', String(pending_aa.length)], ['Status', 'APPROVING']],
        }));
        let approved_aa = 0, failed_aa = 0;
        const BATCH_aa = 20;
        for (let i = 0; i < pending_aa.length; i += BATCH_aa) {
          const batch = pending_aa.slice(i, i + BATCH_aa).map((r) => r.jid);
          try {
            await sock.groupRequestParticipantsUpdate(groupJid, batch, 'approve');
            approved_aa += batch.length;
          } catch {
            for (const j of batch) {
              try { await sock.groupRequestParticipantsUpdate(groupJid, [j], 'approve'); approved_aa++; }
              catch { failed_aa++; }
            }
          }
          if (i + BATCH_aa < pending_aa.length) {
            await updateProgress_aa(asciiBox({
              title: 'APPROVE ALL — RUNNING',
              emoji: '✅',
              rows: [
                ['Total', String(pending_aa.length)],
                ['Approved', String(approved_aa)],
                ['Failed', String(failed_aa)],
                ['Remaining', String(pending_aa.length - approved_aa - failed_aa)],
              ],
            }));
            await new Promise((r) => setTimeout(r, 800));
          }
        }
        await updateProgress_aa(asciiBox({
          title: 'APPROVE ALL — COMPLETE',
          emoji: '✅',
          rows: [
            ['Total', String(pending_aa.length)],
            ['Approved', String(approved_aa)],
            ['Failed', String(failed_aa)],
          ],
        }));
      } catch (err) {
        await reply(errorCard('APPROVE ALL FAILED', String(err)));
      }
      break;
    }

    case 'rejectall': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      const meta_ra = await fetchGroupMeta(socket, groupJid);
      if (!meta_ra?.botIsAdmin) { await reply(errorCard('REJECT ALL', 'I need to be a group admin to manage join requests.')); break; }
      try {
        const sock = socket as unknown as {
          groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string }>>;
          groupRequestParticipantsUpdate(jid: string, p: string[], action: 'approve' | 'reject'): Promise<unknown>;
        };
        const pending_ra = await sock.groupRequestParticipantsList(groupJid);
        if (pending_ra.length === 0) {
          await reply(warningCard('NOTHING TO REJECT', 'No pending join requests found.')); break;
        }
        let rejected_ra = 0, failed_ra = 0;
        const BATCH_ra = 20;
        for (let i = 0; i < pending_ra.length; i += BATCH_ra) {
          const batch = pending_ra.slice(i, i + BATCH_ra).map((r) => r.jid);
          try {
            await sock.groupRequestParticipantsUpdate(groupJid, batch, 'reject');
            rejected_ra += batch.length;
          } catch {
            for (const j of batch) {
              try { await sock.groupRequestParticipantsUpdate(groupJid, [j], 'reject'); rejected_ra++; }
              catch { failed_ra++; }
            }
          }
          if (i + BATCH_ra < pending_ra.length) await new Promise((r) => setTimeout(r, 500));
        }
        await reply(asciiBox({
          title: 'REJECT ALL — COMPLETE',
          emoji: '🚫',
          rows: [['Rejected', String(rejected_ra)], ['Failed', String(failed_ra)]],
        }));
      } catch (err) {
        await reply(errorCard('REJECT ALL FAILED', String(err)));
      }
      break;
    }

    case 'approveamt': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      const amtStr = args[0];
      const amt = amtStr ? parseInt(amtStr, 10) : 0;
      if (!amt || amt < 1) {
        await reply(warningCard('AMOUNT REQUIRED', `Usage: ${config.prefix}approveamt <number>\nExample: ${config.prefix}approveamt 50`));
        break;
      }
      const meta_amt = await fetchGroupMeta(socket, groupJid);
      if (!meta_amt?.botIsAdmin) { await reply(errorCard('APPROVE BY AMOUNT', 'I need to be a group admin to manage join requests.')); break; }
      try {
        const sock = socket as unknown as {
          groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string }>>;
          groupRequestParticipantsUpdate(jid: string, p: string[], action: 'approve' | 'reject'): Promise<unknown>;
        };
        const all_amt = await sock.groupRequestParticipantsList(groupJid);
        const toApprove = all_amt.slice(0, amt);
        if (toApprove.length === 0) {
          await reply(warningCard('NOTHING TO APPROVE', 'No pending join requests found.')); break;
        }
        const updateProgress_amt = await createProgressReply(asciiBox({
          title: 'APPROVE BY AMOUNT',
          emoji: '✅',
          rows: [['Requested', String(amt)], ['Available', String(all_amt.length)], ['Status', 'APPROVING']],
        }));
        let approved_amt = 0, failed_amt = 0;
        const BATCH_amt = 20;
        for (let i = 0; i < toApprove.length; i += BATCH_amt) {
          const batch = toApprove.slice(i, i + BATCH_amt).map((r) => r.jid);
          try {
            await sock.groupRequestParticipantsUpdate(groupJid, batch, 'approve');
            approved_amt += batch.length;
          } catch {
            for (const j of batch) {
              try { await sock.groupRequestParticipantsUpdate(groupJid, [j], 'approve'); approved_amt++; }
              catch { failed_amt++; }
            }
          }
          if (i + BATCH_amt < toApprove.length) await new Promise((r) => setTimeout(r, 800));
        }
        await updateProgress_amt(asciiBox({
          title: 'APPROVE BY AMOUNT — COMPLETE',
          emoji: '✅',
          rows: [
            ['Requested', String(amt)],
            ['Approved', String(approved_amt)],
            ['Failed', String(failed_amt)],
            ['Remaining (total)', String(all_amt.length - toApprove.length)],
          ],
        }));
      } catch (err) {
        await reply(errorCard('APPROVE BY AMOUNT FAILED', String(err)));
      }
      break;
    }

    case 'approvecountry': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      const rawCode = args[0];
      const countryDigits = rawCode ? rawCode.replace(/[^0-9]/g, '') : '';
      if (!countryDigits) {
        await reply(warningCard('COUNTRY CODE REQUIRED',
          `Usage: ${config.prefix}approvecountry <code>\nExamples: ${config.prefix}approvecountry 234 (Nigeria) or ${config.prefix}approvecountry +1 (USA)`
        ));
        break;
      }
      const meta_ac = await fetchGroupMeta(socket, groupJid);
      if (!meta_ac?.botIsAdmin) { await reply(errorCard('APPROVE BY COUNTRY', 'I need to be a group admin to manage join requests.')); break; }
      try {
        const sock = socket as unknown as {
          groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string; phoneNumber?: string }>>;
          groupRequestParticipantsUpdate(jid: string, p: string[], action: 'approve' | 'reject'): Promise<unknown>;
        };
        const all_ac = await sock.groupRequestParticipantsList(groupJid);
        logger.info('[ApproveCountry] Pending requests fetched', { groupJid, total: all_ac.length });
        if (all_ac.length === 0) {
          await reply(warningCard('NO PENDING REQUESTS', 'There are no pending join requests in this group right now.'));
          break;
        }
        // Fetch group participant list once — needed to resolve LID → real phone
        const groupParticipants_ac = meta_ac?.participants ?? [];

        // Resolve LID JIDs — pending requests may be pure @lid with no phoneNumber.
        // Build a lookup map: lidJid → real phone number.
        const lidPhoneMap = new Map<string, string>();
        const lidEntries = all_ac.filter(r => r.jid.endsWith('@lid'));
        if (lidEntries.length > 0) {
          try {
            const sockWithLid = socket as unknown as {
              onWhatsApp(...jids: string[]): Promise<Array<{ exists: boolean; jid: string; lid?: string }>>;
            };
            // onWhatsApp accepts real JIDs, not LIDs — try resolving via group participant phoneNumber first
            for (const entry of lidEntries) {
              const lidNum = (entry.jid.split('@')[0] ?? '').split(':')[0] ?? '';
              // Check group participant list for a matching phoneNumber
              const matched = groupParticipants_ac.find(
                p => (p.phoneNumber ?? '').replace(/\D/g, '') === lidNum
              );
              if (matched && !matched.id.endsWith('@lid')) {
                const phone = (matched.id.split('@')[0] ?? '').split(':')[0] ?? '';
                lidPhoneMap.set(entry.jid, phone);
              }
            }
            // For still-unresolved LIDs, try onWhatsApp in batches
            const unresolved = lidEntries.filter(e => !lidPhoneMap.has(e.jid));
            if (unresolved.length > 0 && typeof sockWithLid.onWhatsApp === 'function') {
              const BATCH_LID = 50;
              for (let i = 0; i < unresolved.length; i += BATCH_LID) {
                const batch = unresolved.slice(i, i + BATCH_LID).map(e => e.jid);
                try {
                  const results = await sockWithLid.onWhatsApp(...batch);
                  for (const res of results) {
                    if (res.exists && res.jid && !res.jid.endsWith('@lid')) {
                      // Find which lid entry this corresponds to via the lid field
                      const lidEntry = unresolved.find(e => res.lid && e.jid.startsWith(res.lid.split('@')[0] ?? ''));
                      if (lidEntry) {
                        const phone = (res.jid.split('@')[0] ?? '').split(':')[0] ?? '';
                        lidPhoneMap.set(lidEntry.jid, phone);
                      }
                    }
                  }
                } catch { /* non-critical */ }
              }
            }
          } catch { /* non-critical */ }
          logger.info('[ApproveCountry] LID resolution', { total: lidEntries.length, resolved: lidPhoneMap.size });
        }

        const matched_ac = all_ac.filter((r) => {
          // Real @s.whatsapp.net JID — extract phone directly
          if (r.jid.endsWith('@s.whatsapp.net')) {
            const jidUser = (r.jid.split('@')[0] ?? '').split(':')[0] ?? '';
            return jidUser.startsWith(countryDigits);
          }
          // LID — use resolved phone map
          if (r.jid.endsWith('@lid')) {
            const resolvedPhone = lidPhoneMap.get(r.jid);
            if (resolvedPhone) return resolvedPhone.startsWith(countryDigits);
            // Fallback: explicit phoneNumber field if Baileys populated it
            const explicitPhone = (r.phoneNumber ?? '').replace(/[^0-9]/g, '');
            return explicitPhone ? explicitPhone.startsWith(countryDigits) : false;
          }
          const explicitPhone = (r.phoneNumber ?? '').replace(/[^0-9]/g, '');
          return explicitPhone ? explicitPhone.startsWith(countryDigits) : false;
        });
        logger.info('[ApproveCountry] Filter result', { countryDigits, matched: matched_ac.length, total: all_ac.length });
        logger.info('[ApproveCountry] Sample JIDs', { samples: all_ac.slice(0, 5).map(r => ({ jid: r.jid, phone: r.phoneNumber, raw: r })) });

        // If all entries are unresolvable LIDs (Baileys limitation), fall back to approving all
        const allLidUnresolved = matched_ac.length === 0 && all_ac.every(r => r.jid.endsWith('@lid')) && lidPhoneMap.size === 0;
        const finalList = allLidUnresolved ? all_ac : matched_ac;

        if (finalList.length === 0) {
          await reply(warningCard('NO MATCHES', `No pending requests with country code +${countryDigits}.\nTotal pending: ${all_ac.length}\n\nTip: check the exact digits — Nigeria is 234, USA is 1.`));
          break;
        }
        const updateProgress_ac = await createProgressReply(asciiBox({
          title: 'APPROVE BY COUNTRY',
          emoji: '✅',
          rows: [
            ['Country', `+${countryDigits}`],
            ['Matched', String(matched_ac.length)],
            ['Total pending', String(all_ac.length)],
            ['Status', 'APPROVING'],
          ],
        }));
        let approved_ac = 0, failed_ac = 0;
        const BATCH_ac = 20;
        for (let i = 0; i < matched_ac.length; i += BATCH_ac) {
          const batch = matched_ac.slice(i, i + BATCH_ac).map((r) => r.jid);
          try {
            await sock.groupRequestParticipantsUpdate(groupJid, batch, 'approve');
            approved_ac += batch.length;
          } catch {
            for (const j of batch) {
              try { await sock.groupRequestParticipantsUpdate(groupJid, [j], 'approve'); approved_ac++; }
              catch { failed_ac++; }
            }
          }
          if (i + BATCH_ac < matched_ac.length) await new Promise((r) => setTimeout(r, 800));
        }
        await updateProgress_ac(asciiBox({
          title: 'APPROVE BY COUNTRY — COMPLETE',
          emoji: '✅',
          rows: [
            ['Country', `+${countryDigits}`],
            ['Matched', String(matched_ac.length)],
            ['Approved', String(approved_ac)],
            ['Failed', String(failed_ac)],
            ['Remaining (other)', String(all_ac.length - matched_ac.length)],
          ],
        }));
      } catch (err) {
        await reply(errorCard('APPROVE BY COUNTRY FAILED', String(err)));
      }
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

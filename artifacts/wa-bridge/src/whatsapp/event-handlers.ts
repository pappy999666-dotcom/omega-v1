// ============================================================
// WA-Bridge — WhatsApp Event Handler
// Processes incoming messages, dispatches commands
// ============================================================

import type { WASocket, proto } from '@crysnovax/baileys';
import type { BaileysEventMap } from '@crysnovax/baileys';
import { parseCommand, parseStickerCommand, hashSticker } from './command-parser.js';
import { loadConfig, loadSessionMeta, updateSessionMeta } from '../services/workspace.js';
import { stopSpamLoop, isSpamLoopActive, cmdToChat, cmdToChatX, cmdSStatus, cmdGroupStatus } from './commands/status.js';
import { cmdAllStatus, cmdAllChat, stopOutreach } from './commands/mass-outreach.js';
import { cmdJoin, cmdLeave, cmdJoinAll, cmdLeaveAll, resolveGroupJid } from './commands/lifecycle.js';
import { cmdTag, cmdMTag, tagSummary } from './commands/tag.js';
import { updateConfig, addToMainBucket } from '../services/workspace.js';
import { logger } from '../utils/logger.js';
import { isFrozen } from './socket-manager.js';
import {
  whatsappMenu,
  asciiBox,
  bold,
  errorCard,
  successCard,
  warningCard,
} from '../utils/ascii-art.js';
import { hydratedMessage } from './preview-generator.js';
import { statusDesignEngine } from '../services/StatusDesignEngine.js';

// Map from sessionId → telegramId (populated at init)
const sessionOwnerMap = new Map<string, string>();

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

// ── Main Event Router ─────────────────────────────────────

export async function handleWAEvent(
  sessionId: string,
  event: keyof BaileysEventMap,
  data: unknown,
  socket: WASocket
): Promise<void> {
  if (event === 'messages.upsert') {
    await handleMessages(sessionId, data as { messages: proto.IWebMessageInfo[]; type: string }, socket);
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
  if (loadConfig(telegramId).sleeping) throw new Error('User sleep mode is active');
  const syntheticMessage = {
    key: { remoteJid: 'status@broadcast', fromMe: false, id: `telegram-${Date.now()}` },
    message: { conversation: text },
  } as proto.IWebMessageInfo;

  await processMessage(sessionId, telegramId, syntheticMessage, socket, onReply);
}

// ── Message Handler ───────────────────────────────────────

async function handleMessages(
  sessionId: string,
  upsert: { messages: proto.IWebMessageInfo[]; type: string },
  socket: WASocket
): Promise<void> {
  if (upsert.type !== 'notify') return;

  const telegramId = sessionOwnerMap.get(sessionId);
  if (!telegramId) return;

  for (const msg of upsert.messages) {
    if (!msg.message) continue;

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
  msg: proto.IWebMessageInfo,
  socket: WASocket,
  replyOverride?: (text: string) => Promise<void>
): Promise<void> {
  const groupJid = msg.key.remoteJid ?? '';
  const isGroup = groupJid.endsWith('@g.us');

  // Extract text from various message types
  const text =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    msg.message?.imageMessage?.caption ??
    msg.message?.videoMessage?.caption ??
    '';

  // Extract sticker for macro matching
  const stickerMsg = msg.message?.stickerMessage;

  const config = loadConfig(telegramId);
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
  const reply = replyOverride ?? (async (replyText: string) => {
    try {
      await socket.sendMessage(groupJid, { text: replyText }, { quoted: msg });
    } catch {
      await socket.sendMessage(groupJid, { text: replyText });
    }
  });

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
      const start = Date.now();
      await reply(asciiBox({
        title: 'PONG',
        emoji: '🏓',
        rows: [['Latency', `${Date.now() - start}ms`], ['Session', sessionId]],
      }));
      break;
    }

    // ── Menu ──
    case 'menu':
    case 'help': {
      await reply(whatsappMenu('WA-BRIDGE CONTROL', [
        {
          heading: '📡 Status Broadcast',
          items: [
            { cmd: '.gstatus [msg]', desc: 'Post to current group status' },
            { cmd: '.tochat [jid] [msg]', desc: 'Send to a target group' },
            { cmd: '.togstatus [jid] [msg]', desc: 'Post to a target group status' },
            { cmd: '.tochatx [jid] [n] [msg]', desc: 'Repeat a target chat send' },
            { cmd: '.togstatusx [n] [jid] [msg]', desc: 'Repeat a target group status' },
            { cmd: '.sstatus [msg]', desc: 'Run status loop until stopspam' },
            { cmd: '.statusdesign [theme] [link]', desc: 'Designed current-GC status' },
          ],
        },
        {
          heading: '📣 Mass Outreach',
          items: [
            { cmd: '.allstatus [msg]', desc: 'Post to all group statuses' },
            { cmd: '.allstatusx [n] [msg]', desc: 'Repeat across every group' },
            { cmd: '.allchat [msg]', desc: 'Send to all groups with hidetag' },
            { cmd: '.stopspam', desc: 'Stop the active status loop' },
          ],
        },
        {
          heading: '🔗 Lifecycle',
          items: [
            { cmd: '.join [link]', desc: 'Join a group' },
            { cmd: '.leave [jid]', desc: 'Leave a group' },
            { cmd: '.joinall', desc: 'Join all active bucket links' },
            { cmd: '.left', desc: 'Leave the current group' },
            { cmd: '.leave [jid/link]', desc: 'Leave a specified group' },
            { cmd: '.leaveall', desc: 'Leave all groups' },
          ],
        },
        {
          heading: '📢 Tagging',
          items: [
            { cmd: '.tag [msg]', desc: 'Hidetag all members (invisible)' },
            { cmd: '.mtag [msg]', desc: 'Visible @mention all members' },
          ],
        },
        {
          heading: '⚙️ Settings',
          items: [
            { cmd: '.setprefix [p]', desc: 'Change command prefix' },
            { cmd: '.setcmd [hash] [cmd]', desc: 'Bind sticker to command' },
            { cmd: '.setsudo [number]', desc: 'Approve a command number' },
            { cmd: '.delsudo [number]', desc: 'Remove command access' },
            { cmd: '.info', desc: 'Session information' },
            { cmd: '.groups', desc: 'List joined groups' },
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

      await reply(asciiBox({
        title: 'SESSION INFO',
        emoji: '📱',
        rows: [
          ['Session', sessionId],
          ['Status', isFrozen(sessionId) ? '❄️ FROZEN' : '🟢 ACTIVE'],
          ['Groups', String(groupCount)],
          ['Prefix', config.prefix || 'null'],
          ['Null Mode', config.nullPrefix ? 'ON' : 'OFF'],
          ['Spam Loop', isSpamLoopActive(sessionId) ? '🔄 RUNNING' : 'OFF'],
        ],
      }));
      break;
    }

    // ── Groups ──
    case 'groups': {
      try {
        const groups = await socket.groupFetchAllParticipating();
        const list = Object.values(groups)
          .slice(0, 30)
          .map((g, i) => `${i + 1}. ${bold(g.subject)} [${g.participants.length}]`)
          .join('\n');
        const total = Object.keys(groups).length;
        await reply(`${bold('📋 JOINED GROUPS')} (${total} total)\n\n${list}${total > 30 ? '\n…and more' : ''}`);
      } catch (err) {
        await reply(`❌ Failed to fetch groups: ${err}`);
      }
      break;
    }

    // ── Set Prefix ──
    case 'setprefix': {
      const newPrefix = args[0];
      if (!newPrefix) {
        await reply(`Current prefix: ${bold(config.prefix || 'null')}\nUsage: .setprefix [prefix]`);
        break;
      }
      updateConfig(telegramId, { prefix: newPrefix === 'null' ? '' : newPrefix, nullPrefix: newPrefix === 'null' });
      await reply(`✅ Prefix updated to: ${bold(newPrefix)}`);
      break;
    }

    // ── Set Sticker Command ──
    case 'setcmd': {
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
      updateConfig(telegramId, { stickerMacros: macros });
      await reply(successCard('STICKER COMMAND SAVED', 'The sticker macro is ready.', [
        ['Hash', hash],
        ['Command', normalizedBinding],
      ]));
      break;
    }

    // ── Sudo Access ──
    case 'sudo': {
      const sudo = config.sudoNumbers ?? [];
      await reply(asciiBox({
        title: 'SUDO ACCESS',
        emoji: '🔐',
        rows: [['Approved numbers', String(sudo.length)]],
        footer: sudo.length ? sudo.map((number) => `+${number}`).join('\n') : 'No sudo numbers configured.',
      }));
      break;
    }
    case 'setsudo':
    case 'delsudo': {
      if (!isOwnerSender && !replyOverride) {
        await reply(errorCard('OWNER ONLY', 'Only the paired session owner can change sudo access.'));
        break;
      }
      const number = normalizeWhatsAppNumber(args[0]);
      if (!number || number.length < 7) {
        await reply(warningCard('VALID NUMBER REQUIRED', `Usage: ${config.prefix}${command} <international number>`));
        break;
      }
      const current = new Set(config.sudoNumbers ?? []);
      if (command === 'setsudo') current.add(number);
      else current.delete(number);
      updateConfig(telegramId, { sudoNumbers: [...current] });
      await reply(successCard(
        command === 'setsudo' ? 'SUDO ADDED' : 'SUDO REMOVED',
        command === 'setsudo' ? 'This number can now run ordinary commands.' : 'Command access was removed.',
        [['Number', `+${number}`]]
      ));
      break;
    }

    // ── JID Resolver ──
    case 'jid': {
      const link = args[0];
      if (!link) { await reply('Usage: .jid [group_link]'); break; }
      const info = await resolveGroupJid(socket, link);
      if (!info) { await reply('❌ Could not resolve JID'); break; }
      await reply(asciiBox({
        title: 'GROUP JID',
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
        await reply(successCard('BACKGROUND JOBS STOPPED', stoppedSpam ? 'The status loop was stopped.' : 'Active outreach cancellation was requested.'));
      } else {
        await reply(warningCard('CHOOSE A JOB', `Usage: ${config.prefix}stop spam`));
      }
      break;
    }

    // ── gstatus ──
    case 'gstatus': {
      const text = args.join(' ');
      if (!isGroup) { await reply('❌ Must be used in a WhatsApp group'); break; }
      if (!text) { await reply('Usage: .gstatus [message]'); break; }
      const sent = await cmdGroupStatus(socket, sessionId, groupJid, text);
      await reply(sent ? '✅ Group status posted!' : '❌ Group status relay failed');
      break;
    }

    // ── tochat ──
    case 'tochat': {
      const [target, ...msgParts] = args;
      if (!target || msgParts.length === 0) { await reply('Usage: .tochat [jid/link] [message]'); break; }
      const res = await cmdToChat(socket, sessionId, target, msgParts.join(' '));
      await reply(res.success ? '✅ Message sent!' : `❌ Failed: ${res.error}`);
      break;
    }

    // ── tochatx ──
    case 'tochatx': {
      const [target, countStr, ...msgParts] = args;
      if (!target || !countStr || msgParts.length === 0) {
        await reply('Usage: .tochatx [jid/link] [count] [message]');
        break;
      }
      const count = Math.min(parseInt(countStr, 10), 50);
      const res = await cmdToChatX(socket, sessionId, target, count, msgParts.join(' '));
      await reply(`✅ Sent ${res.sent}/${count} — ${res.failed} failed`);
      break;
    }

    // ── sstatus ──
    case 'sstatus':
    case 'spam': {
      const text = args.join(' ');
      if (!text) { await reply('Usage: .sstatus [message]\nStop with: .stop spam'); break; }
      if (isSpamLoopActive(sessionId)) { await reply('⚠️ Spam loop already running. Use .stop spam to kill it.'); break; }
      await reply('🔄 Spam status loop started. Send `.stop spam` to kill it.');
      cmdSStatus(socket, sessionId, text).catch(() => { /* background */ });
      break;
    }

    // ── statusdesign ──
    case 'statusdesign': {
      if (!isGroup) { await reply('❌ Must be used in a WhatsApp group'); break; }
      const requestedTheme = statusDesignEngine.themes.includes(args[0]?.toLowerCase() as never)
        ? args.shift()
        : config.statusDesignTheme;
      const url = args.find((arg) => /^https?:\/\/\S+$/u.test(arg));
      if (!url) {
        await reply(`Usage: .statusdesign [theme] [link]\nThemes: ${statusDesignEngine.themes.join(', ')}`);
        break;
      }
      try {
        const design = statusDesignEngine.render({ theme: requestedTheme, url });
        const sent = await cmdGroupStatus(socket, sessionId, groupJid, design.text);
        await reply(sent ? `✅ ${design.theme} group status published` : '❌ Group status relay failed');
      } catch (error) {
        await reply(`❌ ${String(error)}`);
      }
      break;
    }

    // ── Target Group Status ──
    case 'togstatus':
    case 'togstatusx': {
      const repeat = command === 'togstatusx' ? Math.min(Math.max(Number.parseInt(args.shift() ?? '', 10) || 0, 1), 50) : 1;
      const target = args.shift();
      const message = args.join(' ');
      if (!target || !message) {
        await reply(warningCard('TARGET AND MESSAGE REQUIRED', `Usage: ${config.prefix}${command}${command.endsWith('x') ? ' <count>' : ''} <jid or invite link> <message>`));
        break;
      }
      const resolved = target.includes('chat.whatsapp.com') ? await resolveGroupJid(socket, target) : null;
      const targetJid = resolved?.jid ?? target;
      let sent = 0;
      for (let index = 0; index < repeat; index += 1) {
        if (await cmdGroupStatus(socket, sessionId, targetJid, message)) sent += 1;
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
      const text = args.join(' ');
      if (!text) {
        await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}${command}${command.endsWith('x') ? ' <count>' : ''} <message>`));
        break;
      }
      await reply(asciiBox({ title: 'ALL STATUS STARTED', emoji: '📡', rows: [['Repeats', String(repeat)]], footer: 'This job runs in the background. Progress will appear here.' }));
      void (async () => {
        for (let index = 0; index < repeat; index += 1) {
          await cmdAllStatus(socket, sessionId, telegramId, text, {
            onProgress: async (message) => { await reply(message); },
          });
        }
      })().catch(async (error) => {
        logger.error('[EventHandler] allstatus failed', { sessionId, error: String(error) });
        await reply(errorCard('ALL STATUS FAILED', 'The background campaign could not finish.', String(error)));
      });
      break;
    }

    // ── allchat ──
    case 'allchat': {
      const text = args.join(' ');
      if (!text) { await reply('Usage: .allchat [message]'); break; }
      await reply('📣 Starting allchat blast…');
      cmdAllChat(socket, sessionId, telegramId, text, {
        onProgress: async (message) => { await reply(message); },
      }).catch((error) => {
        logger.error('[EventHandler] allchat failed', { sessionId, error: String(error) });
      });
      break;
    }

    // ── join ──
    case 'join': {
      const link = args[0];
      if (!link) { await reply('Usage: .join [group_link]'); break; }
      const res = await cmdJoin(socket, link);
      await reply(res.success
        ? `✅ Joined: ${bold(res.title ?? res.jid ?? 'group')}`
        : `❌ Join failed: ${res.error}`);
      break;
    }

    // ── Leave current group ──
    case 'left': {
      if (!isGroup) {
        await reply(warningCard('GROUP ONLY', 'Use this command inside the group you want the account to leave.'));
        break;
      }
      await reply(warningCard('LEAVING GROUP', 'The account is leaving this group now.'));
      const res = await cmdLeave(socket, groupJid);
      if (!res.success) await reply(errorCard('LEAVE FAILED', res.error ?? 'WhatsApp rejected the request.'));
      break;
    }

    // ── leave ──
    case 'leave': {
      const target = args[0];
      if (!target) { await reply('Usage: .leave [jid/link]'); break; }
      const res = await cmdLeave(socket, target);
      await reply(res.success ? '✅ Left group' : `❌ Leave failed: ${res.error}`);
      break;
    }

    // ── joinall ──
    case 'joinall': {
      const { loadBucket } = await import('../services/workspace.js');
      const links = loadBucket(telegramId, 'active').map((e) => e.link);
      if (links.length === 0) { await reply('❌ Active bucket is empty. Add links via Telegram /bucket first.'); break; }
      await reply(`🔗 Starting joinall for ${links.length} links…`);
      cmdJoinAll(socket, sessionId, telegramId, links, {
        onProgress: async (m) => { try { await socket.sendMessage(groupJid, { text: m }); } catch { /* ignore */ } },
      }).catch(() => { /* background */ });
      break;
    }

    // ── leaveall ──
    case 'leaveall': {
      await reply('🚪 Starting leaveall…');
      cmdLeaveAll(socket, sessionId, telegramId, {
        onProgress: async (m) => { try { await socket.sendMessage(groupJid, { text: m }); } catch { /* ignore */ } },
      }).catch(() => { /* background */ });
      break;
    }

    // ── tag ──
    case 'tag': {
      if (!isGroup) { await reply('❌ Must be used in a group'); break; }
      const text = args.join(' ');
      const res = await cmdTag(socket, sessionId, groupJid, text || '📢');
      await reply(res.success ? tagSummary(res.pinged, 'tag') : `❌ ${res.error}`);
      break;
    }

    // ── mtag ──
    case 'mtag': {
      if (!isGroup) { await reply('❌ Must be used in a group'); break; }
      const text = args.join(' ');
      const res = await cmdMTag(socket, sessionId, groupJid, text || '📢');
      await reply(res.success
        ? `✅ Tagged ${res.pinged} members in ${res.messages} message(s)`
        : `❌ ${res.error}`);
      break;
    }

    // ── Add links to bucket ���─
    case 'addlink': {
      const links = args.filter((a) => a.includes('chat.whatsapp.com'));
      if (links.length === 0) { await reply('Usage: .addlink [link1] [link2]…'); break; }
      const result = addToMainBucket(telegramId, links);
      await reply(`✅ Added ${result.added} links (${result.dupes} dupes skipped)`);
      break;
    }
  }
}

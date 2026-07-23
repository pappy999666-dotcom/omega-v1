// ============================================================
// WA-Bridge — WhatsApp Event Handler
// Processes incoming messages, dispatches commands
// ============================================================

import type { WASocket, proto } from '@crysnovax/baileys';
import type { BaileysEventMap } from '@crysnovax/baileys';
import { parseCommand, parseStickerCommand, hashSticker } from './command-parser.js';
import { loadConfig } from '../services/workspace.js';
import { stopSpamLoop, isSpamLoopActive, cmdGStatus, cmdToChat, cmdToChatX, cmdSStatus, cmdGroupStatus } from './commands/status.js';
import { cmdAllStatus, cmdAllChat, stopOutreach } from './commands/mass-outreach.js';
import { cmdJoin, cmdLeave, cmdJoinAll, cmdLeaveAll, resolveGroupJid } from './commands/lifecycle.js';
import { cmdTag, cmdMTag, tagSummary } from './commands/tag.js';
import { updateConfig, addToMainBucket } from '../services/workspace.js';
import { logger } from '../utils/logger.js';
import { isFrozen } from './socket-manager.js';
import { whatsappMenu, asciiBox, bold, italic } from '../utils/ascii-art.js';
import { hydratedMessage } from './preview-generator.js';

// Map from sessionId → telegramId (populated at init)
const sessionOwnerMap = new Map<string, string>();

export function registerSessionOwner(sessionId: string, telegramId: string): void {
  sessionOwnerMap.set(sessionId, telegramId);
}

export function unregisterSessionOwner(sessionId: string): void {
  sessionOwnerMap.delete(sessionId);
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
    if (msg.key.fromMe) continue;          // Ignore own messages
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
  socket: WASocket
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

  // Parse command
  let parsed = text ? parseCommand(text, config) : null;

  // Try sticker macro
  if (!parsed && stickerMsg?.fileSha256) {
    const stickerBuffer = Buffer.from(stickerMsg.fileSha256 as Uint8Array);
    parsed = parseStickerCommand(stickerBuffer, config);
  }

  if (!parsed) return; // Not a command

  const { command, args } = parsed;
  const reply = async (replyText: string) => {
    try {
      await socket.sendMessage(groupJid, { text: replyText }, { quoted: msg });
    } catch {
      await socket.sendMessage(groupJid, { text: replyText });
    }
  };

  logger.info(`[EventHandler] Command: .${command}`, { sessionId, groupJid });

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
            { cmd: '.gstatus [msg]', desc: 'Post to group status' },
            { cmd: '.tochat [jid] [msg]', desc: 'Send to specific chat' },
            { cmd: '.tochatx [jid] [n] [msg]', desc: 'Send n times' },
            { cmd: '.sstatus [msg]', desc: 'Rapid infinite loop' },
          ],
        },
        {
          heading: '📣 Mass Outreach',
          items: [
            { cmd: '.allstatus [msg]', desc: 'Post to all group statuses' },
            { cmd: '.allchat [msg]', desc: 'Blast to all groups (hidetag)' },
            { cmd: '.stop spam', desc: 'Kill active outreach loop' },
          ],
        },
        {
          heading: '🔗 Lifecycle',
          items: [
            { cmd: '.join [link]', desc: 'Join a group' },
            { cmd: '.leave [jid]', desc: 'Leave a group' },
            { cmd: '.joinall', desc: 'Join all active bucket links' },
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
      const [hash, ...cmdParts] = args;
      const boundCmd = cmdParts.join(' ');
      if (!hash || !boundCmd) {
        await reply('Usage: .setcmd [sticker_hash] [command]\nSend a sticker and I\'ll show its hash.');
        break;
      }
      const macros = { ...config.stickerMacros, [hash]: boundCmd };
      updateConfig(telegramId, { stickerMacros: macros });
      await reply(`✅ Sticker ${bold(hash)} → bound to ${bold(boundCmd)}`);
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
    case 'stop': {
      const target = args[0]?.toLowerCase();
      if (target === 'spam' || target === 'all') {
        const stoppedSpam = stopSpamLoop(sessionId);
        stopOutreach(sessionId);
        await reply(`✅ ${stoppedSpam ? 'Spam loop' : 'Outreach'} stopped.`);
      }
      break;
    }

    // ── gstatus ──
    case 'gstatus': {
      const text = args.join(' ');
      if (!text) { await reply('Usage: .gstatus [message]'); break; }
      await cmdGStatus(socket, sessionId, text);
      await reply('✅ Status posted!');
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
    case 'sstatus': {
      const text = args.join(' ');
      if (!text) { await reply('Usage: .sstatus [message]\nStop with: .stop spam'); break; }
      if (isSpamLoopActive(sessionId)) { await reply('⚠️ Spam loop already running. Use .stop spam to kill it.'); break; }
      await reply('🔄 Spam status loop started. Send `.stop spam` to kill it.');
      cmdSStatus(socket, sessionId, text).catch(() => { /* background */ });
      break;
    }

    // ── allstatus ──
    case 'allstatus': {
      const text = args.join(' ');
      if (!text) { await reply('Usage: .allstatus [message]'); break; }
      await reply('📡 Starting allstatus… check Telegram for progress.');
      cmdAllStatus(socket, sessionId, telegramId, text, {
        onProgress: async (m) => { try { await socket.sendMessage(groupJid, { text: m }); } catch { /* ignore */ } },
      }).catch(() => { /* background */ });
      break;
    }

    // ── allchat ──
    case 'allchat': {
      const text = args.join(' ');
      if (!text) { await reply('Usage: .allchat [message]'); break; }
      await reply('📣 Starting allchat blast…');
      cmdAllChat(socket, sessionId, telegramId, text, {
        onProgress: async (m) => { try { await socket.sendMessage(groupJid, { text: m }); } catch { /* ignore */ } },
      }).catch(() => { /* background */ });
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

    // ── Add links to bucket ──
    case 'addlink': {
      const links = args.filter((a) => a.includes('chat.whatsapp.com'));
      if (links.length === 0) { await reply('Usage: .addlink [link1] [link2]…'); break; }
      const result = addToMainBucket(telegramId, links);
      await reply(`✅ Added ${result.added} links (${result.dupes} dupes skipped)`);
      break;
    }
  }
}

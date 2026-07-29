// ============================================================
// Anti System — Main Engine
// Lightweight, event-driven moderation for WhatsApp groups.
// Each module is fully isolated. Errors in one never affect others.
// ============================================================

import type { BridgeWASocket as WASocket, WebMessageInfo } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';
import { loadGroupAntiConfig } from './config.js';
import { normalizeWhatsAppNumber } from '../event-handlers.js';
import { executeAction, deleteMessage } from './actions.js';
import type { ViolationContext } from './types.js';
import { loadGroupEventConfig } from '../../services/group-config.js';
import { renderTemplate } from '../../utils/response-engine.js';

// Modules
import { messageContainsLink } from './modules/anti-link.js';
import { messageIsFromBot } from './modules/anti-bot.js';
import { recordSpamMessage, resetSpamWindow } from './config.js';
import { messageIsImage, messageIsVideo, messageIsAudio } from './modules/anti-media.js';
import { messageIsVoiceNote } from './modules/anti-vn.js';
import { messageIsPlainText } from './modules/anti-text.js';
import { messageContainsEmoji } from './modules/anti-emoji.js';
import { messageIsSticker } from './modules/anti-sticker.js';
import { messageIsGroupCall } from './modules/anti-group-call.js';
import { messageIsNSFW } from './modules/anti-nsfw.js';
import { messageIsGroupMention } from './modules/anti-group-mention.js';
import { messageContainsBlockedWord } from './modules/anti-words.js';
import { messageIsPoll } from './modules/anti-poll.js';
import { messageIsForwarded } from './modules/anti-forward.js';
import { messageIsFromChannel } from './modules/anti-channel.js';
import type { AntiModuleConfig } from './types.js';

type ModuleKey =
  | 'antilink' | 'antibot' | 'antispam' | 'antipic' | 'antivid' | 'antiaud'
  | 'antivn' | 'antitxt' | 'antiemoji' | 'antisticker' | 'antigroupcall'
  | 'antinsfw' | 'antigroupmention' | 'antiwords' | 'antipoll'
  | 'antiforward' | 'antichannel';

/** Check if sender is in a module's permit list */
function isPermitted(moduleConfig: AntiModuleConfig, senderNumber: string): boolean {
  return moduleConfig.permitList.some((n) => normalizeWhatsAppNumber(n) === senderNumber);
}

/**
 * Build ViolationContext and run executeAction for a detected violation.
 * Each module catches its own error — one failure does not stop others.
 */
async function triggerViolation(
  socket: WASocket,
  msg: WebMessageInfo,
  sessionId: string,
  telegramId: string,
  groupJid: string,
  senderJid: string,
  senderNumber: string,
  moduleKey: ModuleKey,
  moduleName: string,
  moduleConfig: AntiModuleConfig,
  customMessageKey?: string
): Promise<void> {
  try {
    const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
    const resolvedMsg = (customMessageKey && gc.messages?.[customMessageKey]) ?? moduleConfig.customMessage;
    const ctx: ViolationContext = {
      sessionId,
      telegramId,
      groupJid,
      senderJid,
      senderNumber,
      moduleKey,
      moduleName,
      moduleConfig: { ...moduleConfig, customMessage: resolvedMsg },
      defaultMessage: '',
    };
    await executeAction(socket, msg, ctx);
  } catch (err) {
    logger.error(`[AntiSystem] ${moduleName} action failed`, { err: String(err), sessionId, groupJid });
  }
}

/**
 * Called for every incoming group message (messages.upsert).
 * Runs all enabled anti modules concurrently where safe.
 * Returns true if any module triggered (caller can skip command parsing).
 */
export async function runAntiChecks(
  socket: WASocket,
  msg: WebMessageInfo,
  sessionId: string,
  telegramId: string
): Promise<boolean> {
  // Only process group messages from other users
  if (msg.key.fromMe) return false;

  const groupJid = msg.key.remoteJid ?? '';
  if (!groupJid.endsWith('@g.us')) return false;

  const senderJid = msg.key.participant ?? '';
  if (!senderJid) return false;
  const senderNumber = normalizeWhatsAppNumber(senderJid);

  // Load group config once
  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);

  const violations: Promise<void>[] = [];
  let triggered = false;

  // ── Helper: run a synchronous check ──────────────────────────────
  function tryModule(
    key: ModuleKey,
    name: string,
    check: () => boolean,
    msgKey?: string
  ): void {
    try {
      const mod = gc[key] as AntiModuleConfig | undefined;
      if (!mod?.enabled) return;
      if (isPermitted(mod, senderNumber)) return;
      if (!check()) return;
      triggered = true;
      violations.push(triggerViolation(socket, msg, sessionId, telegramId, groupJid, senderJid, senderNumber, key, name, mod, msgKey));
    } catch (err) {
      logger.warn(`[AntiSystem] ${name} check threw`, { err: String(err) });
    }
  }

  // ── AntiLink ─────────────────────────────────────────────
  tryModule('antilink', 'AntiLink', () => messageContainsLink(msg), 'antilink');

  // ── AntiBot ──────────────────────────────────────────────
  tryModule('antibot', 'AntiBot', () => messageIsFromBot(msg), 'antibot');

  // ── AntiSpam (rolling window) ─────────────────────────────
  try {
    const spamCfg = gc.antispam;
    if (spamCfg?.enabled && !isPermitted(spamCfg, senderNumber)) {
      const count = recordSpamMessage(sessionId, groupJid, senderNumber, spamCfg.windowSeconds);
      if (count > spamCfg.messageLimit) {
        resetSpamWindow(sessionId, groupJid, senderNumber);
        triggered = true;
        violations.push(triggerViolation(socket, msg, sessionId, telegramId, groupJid, senderJid, senderNumber, 'antispam', 'AntiSpam', spamCfg, 'antispam'));
      }
    }
  } catch (err) {
    logger.warn('[AntiSystem] AntiSpam check threw', { err: String(err) });
  }

  // ── AntiPic / AntiVid / AntiAud ───────────────────────────
  tryModule('antipic', 'AntiPic', () => messageIsImage(msg), 'antipic');
  tryModule('antivid', 'AntiVid', () => messageIsVideo(msg), 'antivid');
  tryModule('antiaud', 'AntiAud', () => messageIsAudio(msg), 'antiaud');

  // ── AntiVN ───────────────────────────────────────────────
  tryModule('antivn', 'AntiVN', () => messageIsVoiceNote(msg), 'antivn');

  // ── AntiText ─────────────────────────────────────────────
  tryModule('antitxt', 'AntiText', () => messageIsPlainText(msg), 'antitxt');

  // ── AntiEmoji ────────────────────────────────────────────
  tryModule('antiemoji', 'AntiEmoji', () => messageContainsEmoji(msg), 'antiemoji');

  // ── AntiSticker ──────────────────────────────────────────
  tryModule('antisticker', 'AntiSticker', () => messageIsSticker(msg), 'antisticker');

  // ── AntiGroupCall ────────────────────────────────────────
  tryModule('antigroupcall', 'AntiGroupCall', () => messageIsGroupCall(msg), 'antigroupcall');

  // ── AntiGroupMention ─────────────────────────────────────
  tryModule('antigroupmention', 'AntiGroupMention', () => messageIsGroupMention(msg), 'antigroupmention');

  // ── AntiPoll ─────────────────────────────────────────────
  tryModule('antipoll', 'AntiPoll', () => messageIsPoll(msg), 'antipoll');

  // ── AntiForward ──────────────────────────────────────────
  tryModule('antiforward', 'AntiForward', () => messageIsForwarded(msg), 'antiforward');

  // ── AntiChannel ──────────────────────────────────────────
  tryModule('antichannel', 'AntiChannel', () => messageIsFromChannel(msg), 'antichannel');

  // ── AntiWords ────────────────────────────────────────────
  try {
    const wordsCfg = gc.antiwords;
    if (wordsCfg?.enabled && !isPermitted(wordsCfg, senderNumber)) {
      const matched = messageContainsBlockedWord(msg, wordsCfg.words);
      if (matched) {
        triggered = true;
        violations.push(triggerViolation(socket, msg, sessionId, telegramId, groupJid, senderJid, senderNumber, 'antiwords', 'AntiWords', wordsCfg, 'antiwords'));
      }
    }
  } catch (err) {
    logger.warn('[AntiSystem] AntiWords check threw', { err: String(err) });
  }

  // ── AntiNSFW (async — runs separately to avoid blocking sync checks) ─
  const nsfwCfg = gc.antinsfw;
  if (nsfwCfg?.enabled && !isPermitted(nsfwCfg, senderNumber)) {
    violations.push(
      messageIsNSFW(socket, msg).then((isNsfw) => {
        if (!isNsfw) return;
        return triggerViolation(socket, msg, sessionId, telegramId, groupJid, senderJid, senderNumber, 'antinsfw', 'AntiNSFW', nsfwCfg, 'antinsfw');
      }).catch((err) => {
        logger.warn('[AntiSystem] AntiNSFW threw', { err: String(err) });
      })
    );
  }

  if (violations.length > 0) {
    await Promise.allSettled(violations);
  }

  return triggered;
}

// ── Group Participant Event Handler ───────────────────────

export interface ParticipantUpdateEvent {
  id: string;
  participants: string[];
  action: 'add' | 'remove' | 'promote' | 'demote';
  author?: string;
}

/**
 * Handle group-participants.update events for AntiPromote and AntiDemote.
 */
export async function handleParticipantUpdate(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  update: ParticipantUpdateEvent
): Promise<void> {
  const { id: groupJid, participants, action, author } = update;
  if (!groupJid.endsWith('@g.us')) return;
  if (!author) return; // no actor identified

  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const authorNumber = normalizeWhatsAppNumber(author);

  // ── AntiPromote ──────────────────────────────────────────
  if (action === 'promote' && gc.antipromote?.enabled) {
    const mod = gc.antipromote;
    if (!isPermitted(mod, authorNumber)) {
      logger.info('[AntiSystem] AntiPromote triggered', { sessionId, groupJid, author });
      const ops: Promise<unknown>[] = [];

      if (mod.action === 'kick') {
        ops.push(
          (socket as unknown as {
            groupParticipantsUpdate(jid: string, p: string[], a: string): Promise<unknown>;
          }).groupParticipantsUpdate(groupJid, [author], 'remove')
        );
      } else {
        // warn / delete → demote the responsible admin
        ops.push(
          (socket as unknown as {
            groupParticipantsUpdate(jid: string, p: string[], a: string): Promise<unknown>;
          }).groupParticipantsUpdate(groupJid, [author], 'demote')
        );
      }

      const msg = mod.customMessage ?? `⚠️ @${authorNumber} performed an unauthorized promotion and has been actioned.`;
      ops.push(socket.sendMessage(groupJid, { text: msg, mentions: [author] }));
      await Promise.allSettled(ops);
    }
  }

  // ── Welcome Message ──────────────────────────────────────
  if (action === 'add') {
    const eventConfig = loadGroupEventConfig(telegramId, sessionId, groupJid);
    if (eventConfig.welcomeEnabled && eventConfig.welcomeMessage) {
      let gcName = groupJid.split('@')[0] ?? 'Group';
      try {
        const meta = await (socket as unknown as {
          groupMetadata(jid: string): Promise<{ subject?: string }>;
        }).groupMetadata(groupJid);
        gcName = meta?.subject ?? gcName;
      } catch { /* non-critical */ }

      for (const participantJid of participants) {
        try {
          const rendered = await renderTemplate(eventConfig.welcomeMessage, {
            senderJid: participantJid,
            gcName,
            socket,
            groupJid,
          });
          await socket.sendMessage(groupJid, { text: rendered, mentions: [participantJid] });
        } catch (err) {
          logger.warn('[GroupEvents] Welcome send failed', { err: String(err), participantJid });
        }
      }
    }
  }

  // ── Goodbye Message ──────────────────────────────────────
  if (action === 'remove') {
    const eventConfig = loadGroupEventConfig(telegramId, sessionId, groupJid);
    if (eventConfig.goodbyeEnabled && eventConfig.goodbyeMessage) {
      let gcName = groupJid.split('@')[0] ?? 'Group';
      try {
        const meta = await (socket as unknown as {
          groupMetadata(jid: string): Promise<{ subject?: string }>;
        }).groupMetadata(groupJid);
        gcName = meta?.subject ?? gcName;
      } catch { /* non-critical */ }

      for (const participantJid of participants) {
        try {
          const rendered = await renderTemplate(eventConfig.goodbyeMessage, {
            senderJid: participantJid,
            gcName,
            socket,
            groupJid,
          });
          await socket.sendMessage(groupJid, { text: rendered, mentions: [participantJid] });
        } catch (err) {
          logger.warn('[GroupEvents] Goodbye send failed', { err: String(err), participantJid });
        }
      }
    }
  }

  // ── AntiDemote ───────────────────────────────────────────
  if (action === 'demote' && gc.antidemote?.enabled) {
    const mod = gc.antidemote;
    if (!isPermitted(mod, authorNumber)) {
      logger.info('[AntiSystem] AntiDemote triggered', { sessionId, groupJid, author, mode: mod.mode });
      const ops: Promise<unknown>[] = [];

      const sock = socket as unknown as {
        groupParticipantsUpdate(jid: string, p: string[], a: string): Promise<unknown>;
      };

      // Act on the responsible admin
      if (mod.mode === 'dwp' || mod.mode === 'dnp') {
        // Demote responsible
        ops.push(sock.groupParticipantsUpdate(groupJid, [author], 'demote'));
      } else if (mod.mode === 'kwp' || mod.mode === 'knp') {
        // Kick responsible
        ops.push(sock.groupParticipantsUpdate(groupJid, [author], 'remove'));
      }

      // Restore victim (dnp / knp)
      if ((mod.mode === 'dnp' || mod.mode === 'knp') && participants.length > 0) {
        ops.push(sock.groupParticipantsUpdate(groupJid, participants, 'promote'));
      }

      const actionWord = (mod.mode === 'dwp' || mod.mode === 'dnp') ? 'demoted' : 'kicked';
      const restoreNote = (mod.mode === 'dnp' || mod.mode === 'knp') ? ' Victim admin rights have been restored.' : '';
      const msg =
        mod.customMessage ??
        `🛡️ AntiDemote: @${authorNumber} has been ${actionWord} for unauthorized demotion.${restoreNote}`;
      ops.push(socket.sendMessage(groupJid, { text: msg, mentions: [author, ...participants] }));

      await Promise.allSettled(ops);
    }
  }
}

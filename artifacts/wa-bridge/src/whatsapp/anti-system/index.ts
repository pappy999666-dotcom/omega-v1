// ============================================================
// Anti System — Main Engine
// Lightweight, event-driven moderation for WhatsApp groups.
// Each module is fully isolated. Errors in one never affect others.
//
// v2 changes:
//  • All modules now skip protected participants (admins, bot,
//    global owner, sudo users).
//  • LID sender JIDs are resolved to real JIDs via group meta.
//  • handleParticipantUpdate no longer returns early when there
//    is no `author`, so Welcome/Goodbye always fire on add/remove.
//  • AutoBlock: per-group toggle that blocks new joiners.
// ============================================================

import type { BridgeWASocket as WASocket, WebMessageInfo } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';
import { loadGroupAntiConfig } from './config.js';
import { normalizeWhatsAppNumber } from '../event-handlers.js';
import { executeAction, deleteMessage } from './actions.js';
import type { ViolationContext } from './types.js';
import { loadGroupEventConfig } from '../../services/group-config.js';
import { renderTemplate, hasTemplateVariable } from '../../utils/response-engine.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { resolveIdentity, profilePicBuffer } from '../utils/identity.js';
import {
  fetchGroupMeta,
  isProtectedJid,
  bestRealJid,
  bustGroupMetaCache,
  patchGroupMetaCache,
} from '../utils/group-permissions.js';
import { handleAntiPromoteEvent, handleAntiDemoteEvent } from './group-security-engine.js';

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
import { messageIsGroupStatusMention } from './modules/anti-gm.js';
import { messageContainsBlockedWord } from './modules/anti-words.js';
import { messageIsPoll } from './modules/anti-poll.js';
import { messageIsForwarded } from './modules/anti-forward.js';
import { messageIsFromChannel } from './modules/anti-channel.js';
import type { AntiModuleConfig } from './types.js';

type ModuleKey =
  | 'antilink' | 'antibot' | 'antispam' | 'antipic' | 'antivid' | 'antiaud'
  | 'antivn' | 'antitxt' | 'antiemoji' | 'antisticker' | 'antigroupcall'
  | 'antinsfw' | 'antigroupmention' | 'antigm' | 'antiwords' | 'antipoll'
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
 *
 * v2: Protected participants (admins, owner, bot, sudo users) are
 * automatically skipped — no module will ever punish an admin.
 *
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

  const rawSenderJid = msg.key.participant ?? '';
  if (!rawSenderJid) return false;

  // ── Resolve real JID (handles LID → real JID) and check protection ──
  // Fetch group meta once; used for both the admin-skip check and LID resolution.
  const meta = await fetchGroupMeta(socket, groupJid).catch(() => null);

  // Resolve the real JID from LID if necessary
  const senderJid = meta
    ? bestRealJid(meta.participants, rawSenderJid)
    : rawSenderJid;

  const senderNumber = normalizeWhatsAppNumber(senderJid);

  // ── Protected-participant guard ──────────────────────────────────────
  // Never apply any anti-module to admins, the bot itself, or sudo users.
  if (meta) {
    const config = await import('../../services/workspace.js').then((m) =>
      m.loadSessionConfig(telegramId, sessionId)
    ).catch(() => null);

    if (isProtectedJid(meta, senderJid, config?.sudoNumbers ?? [])) {
      logger.debug('[AntiSystem] Skipping protected participant', { senderJid, groupJid });
      return false;
    }
  }

  // Load group anti-config once
  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);

  const violations: Promise<void>[] = [];
  let triggered = false;

  logger.debug('[AntiSystem] runAntiChecks starting', {
    sessionId,
    groupJid,
    senderJid,
    senderNumber,
  });

  // ── Helper: run a synchronous check ──────────────────────────────
  function tryModule(
    key: ModuleKey,
    name: string,
    check: () => boolean,
    msgKey?: string
  ): void {
    try {
      const mod = gc[key] as AntiModuleConfig | undefined;
      if (!mod?.enabled) {
        logger.debug(`[AntiSystem] ${name} skipped (disabled)`, { sessionId, groupJid });
        return;
      }
      if (isPermitted(mod, senderNumber)) {
        logger.debug(`[AntiSystem] ${name} skipped (permitted)`, { sessionId, groupJid, senderNumber });
        return;
      }
      const detected = check();
      logger.debug(`[AntiSystem] ${name} check result`, { detected, sessionId, groupJid });
      if (!detected) return;
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
      logger.debug('[AntiSystem] AntiSpam window', { sessionId, groupJid, senderNumber, count, limit: spamCfg.messageLimit, windowSeconds: spamCfg.windowSeconds });
      if (count >= spamCfg.messageLimit) {
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
  // Pass currentGroupJid so the module can filter out self-referential
  // contextInfo.groupMentions and empty join-notification wrappers.
  tryModule('antigroupmention', 'AntiGroupMention', () => messageIsGroupMention(msg, groupJid), 'antigroupmention');

  // ── AntiGM: group mentioned from WhatsApp Status ──────────
  tryModule('antigm', 'AntiGM', () => messageIsGroupStatusMention(msg, groupJid), 'antigm');

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
    triggered = true; // Mark as potentially triggered; actual violation only if detected
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

// ── Built-in default templates ─────────────────────────────
// Used whenever a group has the feature enabled but no custom message:
// the event must NEVER silently skip because a template is empty.

export const DEFAULT_WELCOME_TEMPLATE =
  `👋 Welcome @mention!\n\n` +
  `You have joined *&gcname*.\n` +
  `Members: &membercount • Admins: &admincount\n` +
  `Read the description (&desc) and enjoy the group.\n` +
  `— &date &time`;

export const DEFAULT_GOODBYE_TEMPLATE =
  `👋 @mention has left the group.\n` +
  `*&gcname* now has &membercount members.\n` +
  `— &date &time`;

// ── Group Participant Event Handler ───────────────────────

export interface ParticipantUpdateEvent {
  id: string;
  participants: string[];
  action: 'add' | 'remove' | 'promote' | 'demote';
  author?: string;
}

/**
 * Handle group-participants.update events.
 *
 * Covers:
 *  • AntiPromote / AntiDemote (require `author`)
 *  • Welcome messages  (action = 'add')
 *  • Goodbye messages  (action = 'remove')
 *  • AutoBlock         (action = 'add', per-group toggle)
 *
 * NOTE: `author` is NOT required for Welcome/Goodbye — those fire on
 *   every add/remove regardless of whether an admin initiated it.
 */
export async function handleParticipantUpdate(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  update: ParticipantUpdateEvent
): Promise<void> {
  const { id: groupJid, participants, action, author } = update;
  if (!groupJid.endsWith('@g.us')) return;

  // For 'remove' events the goodbye handler needs a metadata snapshot that still
  // contains the leaving participants so it can resolve LID → real JID.
  // Fetch it BEFORE patchGroupMetaCache strips them from the Baileys store cache.
  let preRemoveSnapshot: { subject?: string; participants?: { id: string; phoneNumber?: string }[] } | null = null;
  if (action === 'remove') {
    try {
      preRemoveSnapshot = await (socket as unknown as {
        groupMetadata(jid: string): Promise<{ subject?: string; participants: { id: string; phoneNumber?: string }[] }>;
      }).groupMetadata(groupJid);
    } catch { /* non-critical — goodbye still sends with raw JID */ }
  }

  // Surgically patch the in-memory metadata cache for this action.
  // promote/demote flip admin flags instantly — no network round-trip on
  // the next anti-check.  add/remove keep the participant list in sync.
  // bustGroupMetaCache is kept as a hard fallback for unexpected actions.
  if (action === 'promote' || action === 'demote' || action === 'add' || action === 'remove') {
    patchGroupMetaCache(socket, groupJid, action, participants);
  } else {
    bustGroupMetaCache(socket, groupJid);
  }

  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);

  // ── AntiPromote ──────────────────────────────────────────
  // Delegated to Group Security Engine (full permission gate +
  // bot-admin check + retry restore + structured audit log).
  if (action === 'promote') {
    await handleAntiPromoteEvent(socket, sessionId, telegramId, {
      id: groupJid,
      participants,
      action: 'promote',
      author,
    }).catch((err) => {
      logger.error('[AntiSystem] handleAntiPromoteEvent threw', { err: String(err), sessionId, groupJid });
    });
  }

  // ── Welcome Message ──────────────────────────────────────
  if (action === 'add') {
    // Welcome messages — fire unless explicitly disabled (.welcome off).
    // A missing custom template falls back to the built-in default so the
    // event is never silently dropped.
    const eventConfig = loadGroupEventConfig(telegramId, sessionId, groupJid);
    const welcomeTemplate =
      eventConfig.welcomeMessage?.trim() || DEFAULT_WELCOME_TEMPLATE;

    if (eventConfig.welcomeEnabled !== false) {
      let gcName = groupJid.split('@')[0] ?? 'Group';
      let welcomeMeta: { subject?: string; participants?: { id: string; phoneNumber?: string }[] } | null = null;
      try {
        welcomeMeta = await (socket as unknown as {
          groupMetadata(jid: string): Promise<{ subject?: string; participants: { id: string; phoneNumber?: string }[] }>;
        }).groupMetadata(groupJid);
        gcName = welcomeMeta?.subject ?? gcName;
      } catch { /* non-critical */ }

      for (const participantJid of participants) {
        try {
          // Resolve LID → real phone JID through the central identity resolver.
          // An unresolved LID is NEVER used in a mention (would leak the LID).
          const resolved = await resolveIdentity(socket, participantJid, welcomeMeta?.participants ?? null);
          const mentionJid = resolved.jid || (participantJid.endsWith('@lid') ? '' : participantJid);
          const mentionNumber = resolved.number || '';

          const rendered = await renderTemplate(welcomeTemplate, {
            senderJid: mentionJid || participantJid,
            gcName,
            socket,
            groupJid,
          });

          // &pp → attach the joining member's profile picture as media.
          const mentionList = mentionJid ? [mentionJid] : undefined;
          if (hasTemplateVariable(welcomeTemplate, 'pp')) {
            const pp = await profilePicBuffer(socket, mentionJid || undefined);
            if (pp) {
              await PreviewManager.send(socket as any, groupJid, rendered, {
                media: { buffer: pp, type: 'image', caption: rendered },
                ...(mentionList ? { extra: { mentions: mentionList } } : {}),
                sessionId,
                telegramId,
              });
              continue;
            }
          }

          await PreviewManager.send(socket as any, groupJid, rendered, {
            ...(mentionList ? { extra: { mentions: mentionList } } : {}),
            sessionId,
            telegramId,
          });
          logger.info('[GroupEvents] Welcome sent', {
            sessionId, groupJid, participantJid, mentionJid, mentionNumber,
          });
        } catch (err) {
          logger.warn('[GroupEvents] Welcome send failed', { err: String(err), participantJid });
        }
      }
    }

    // AutoBlock: block new members if enabled and they are not protected
    if (eventConfig.autoblockEnabled) {
      let blockMeta = null;
      try {
        blockMeta = await fetchGroupMeta(socket, groupJid);
      } catch { /* ignore */ }

      const config = await import('../../services/workspace.js').then((m) =>
        m.loadSessionConfig(telegramId, sessionId)
      ).catch(() => null);

      for (const participantJid of participants) {
        try {
          // Skip protected participants (admins, bot, sudo)
          if (blockMeta && isProtectedJid(blockMeta, participantJid, config?.sudoNumbers ?? [])) {
            logger.debug('[AutoBlock] Skipping protected participant', { participantJid });
            continue;
          }
          await (socket as unknown as {
            updateBlockStatus(jid: string, action: string): Promise<unknown>;
          }).updateBlockStatus(participantJid, 'block');
          logger.info('[AutoBlock] Blocked new member', { sessionId, groupJid, participantJid });
        } catch (err) {
          logger.warn('[AutoBlock] Block failed', { err: String(err), participantJid });
        }
      }
    }
  }

  // ── Goodbye Message ──────────────────────────────────────
  if (action === 'remove') {
    const eventConfig = loadGroupEventConfig(telegramId, sessionId, groupJid);
    const goodbyeTemplate =
      eventConfig.goodbyeMessage?.trim() || DEFAULT_GOODBYE_TEMPLATE;

    if (eventConfig.goodbyeEnabled !== false) {
      let gcName = groupJid.split('@')[0] ?? 'Group';
      // Use the pre-remove snapshot captured above so LID resolution can still
      // find the leaving participants (patchGroupMetaCache already removed them
      // from the Baileys store, so a fresh groupMetadata() call would miss them).
      const goodbyeMeta = preRemoveSnapshot;
      if (goodbyeMeta?.subject) gcName = goodbyeMeta.subject;

      for (const participantJid of participants) {
        try {
          // Central identity resolution — never leak a LID.
          const resolved = await resolveIdentity(socket, participantJid, goodbyeMeta?.participants ?? null);
          const mentionJid = resolved.jid || (participantJid.endsWith('@lid') ? '' : participantJid);

          const rendered = await renderTemplate(goodbyeTemplate, {
            senderJid: mentionJid || participantJid,
            gcName,
            socket,
            groupJid,
          });

          const mentionList = mentionJid ? [mentionJid] : undefined;
          if (hasTemplateVariable(goodbyeTemplate, 'pp')) {
            const pp = await profilePicBuffer(socket, mentionJid || undefined);
            if (pp) {
              await PreviewManager.send(socket as any, groupJid, rendered, {
                media: { buffer: pp, type: 'image', caption: rendered },
                ...(mentionList ? { extra: { mentions: mentionList } } : {}),
                sessionId,
                telegramId,
              });
              continue;
            }
          }

          await PreviewManager.send(socket as any, groupJid, rendered, {
            ...(mentionList ? { extra: { mentions: mentionList } } : {}),
            sessionId,
            telegramId,
          });
          logger.info('[GroupEvents] Goodbye sent', {
            sessionId, groupJid, participantJid, mentionJid,
          });
        } catch (err) {
          logger.warn('[GroupEvents] Goodbye send failed', { err: String(err), participantJid });
        }
      }
    }
  }

  // ── AntiDemote ───────────────────────────────────────────
  // Delegated to Group Security Engine (full permission gate +
  // bot-admin check + retry restore + structured audit log).
  if (action === 'demote') {
    await handleAntiDemoteEvent(socket, sessionId, telegramId, {
      id: groupJid,
      participants,
      action: 'demote',
      author,
    }).catch((err) => {
      logger.error('[AntiSystem] handleAntiDemoteEvent threw', { err: String(err), sessionId, groupJid });
    });
  }
}

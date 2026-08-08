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
import { normalizeParticipantUpdateJids, getContextInfoAny, quotedMessageOf, extractMessageTextAny, resolveIdentity, profilePicBuffer } from './utils/identity.js';
import { resolveMention, sanitizeMentionJids } from './utils/mention-engine.js';
import {
  loadSessionConfig,
  loadSessionMeta,
  updateSessionMeta,
  saveSessionMeta,
  getGlobalSudoNumbers,
  getOmniOwnerNumbers,
  isOmniOwnerNumber,
} from '../services/workspace.js';
import { stopSpamLoop, isSpamLoopActive, cmdToChat, cmdToChatX, cmdSStatus, cmdGroupStatus } from './commands/status.js';
import { cmdAllStatus, cmdAllGStatus, stopAllStatus, isAllStatusRunning } from './commands/all-status.js';
import { cmdAllChat, stopOutreach, isOutreachRunning } from './commands/mass-outreach.js';
import { cmdJoin, cmdLeave, cmdJoinAll, cmdLeaveAll, resolveGroupJid } from './commands/lifecycle.js';
import { cmdTag, cmdMTag, tagSummary } from './commands/tag.js';
import { updateSessionConfig, addToMainBucket } from '../services/workspace.js';
import { logger } from '../utils/logger.js';
import { isFrozen, reinitSocket, normalizePairingPhone, getSocket } from './socket-manager.js';
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
  connectedCard,
} from '../utils/ascii-art.js';
// ── SINGLE IMPORT: All preview operations go through PreviewManager ──
import { PreviewManager } from '../preview-engine/index.js';
import { statusDesignEngine } from '../services/StatusDesignEngine.js';
import type { SessionMeta } from '../types/index.js';
import { pendingGcCodes } from '../telegram/bot.js';
import { ALL_COMMANDS } from './command-parser.js';
import {
  MENU_CATALOG,
  renderNavHub,
  navHubButtons,
  helpPageText,
} from './menu-registry.js';
import { parseInteraction, routeInteraction } from './interaction-router.js';
import { rememberStatusContact } from './utils/status-jids.js';
import { pingTableData, nativeTableContent, tableFromCard } from './utils/native-rich.js';
import { errorReportText, errorReportTable, BOT_VERSION, platformLabel } from '../utils/error-report.js';
import { addIdea } from '../services/ideas.js';
// ── Anti System ───────────────────────────────────────────
import { runAntiChecks, handleParticipantUpdate } from './anti-system/index.js';
// ── Personal Engine (View Once · Anti Delete · Status Platform) ──
import {
  cacheMessage,
  maybeAutoViewOnce,
  maybeAutoSend,
  maybeAutoDownloadStatus,
  handleDeletedKey,
  cmdViewOnce,
  cmdAutoVV,
  cmdAntiDelete,
  cmdPStatus,
  cmdAutoSend,
  cmdAutoDStatus,
  cmdAutoStatusReact,
  cmdSStatusSave,
} from './personal-engine.js';
// ── Runtime stores (dedupe, getMessage, contacts, presence, status) ──
import {
  markSeen,
  rememberMessage,
  loadMessage,
  upsertContacts,
  setPresence,
  setGroupMetaSnapshot,
  noteReaction,
} from './message-store.js';
import {
  handleAntiCommand,
  handleAntiWordsCommand,
  handlePermitCommand,
  handleSpamlimit,
  handleAntiMsg,
  handleAntiAddWord,
  handleAntiRemoveWord,
  handleAntiWordList,
  handleSetAntiWords,
  handleRemoveAntiWords,
  handleClearAntiWords,
  handleAntiDemote,
  handleAntiPromoteCmd,
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
import { setAutoblockConfig, loadGroupEventConfig } from '../services/group-config.js';
import { fetchGroupMeta, resolveRealJidFromMeta, bustGroupMetaCache } from './utils/group-permissions.js';
import { filterPendingRequestsByCountry } from './utils/join-approval.js';
import { updateSessionProfilePicture } from './utils/profile-controls.js';
import { parseUrlButtons } from './utils/url-buttons.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { sessionDir } from '../services/workspace.js';
import { resolveMenuMedia } from '../services/menu-canvas.js';
import { gameManager, type GameResponse } from './games/engine.js';
// ── Poll Game Engine (AI-powered WYR / Quiz) ───────────────
import { createPollGameEngine, GameAI, type PollEvent, type PollGameSnapshot } from './games/poll-engine/index.js';
import { decryptVoteToOption, optionHashHex, registerPollSecret } from './games/poll-engine/poll-votes.js';
import { savePollGameSnapshot, loadPollGameSnapshots, clearPollGameSnapshots } from './games/poll-engine/persistence.js';

// Map from sessionId → telegramId (populated at init)
const sessionOwnerMap = new Map<string, string>();

// A single real vote may be surfaced by both the fork's raw
// pollUpdateMessage upsert and its optional decrypted messages.update path.
// Keep a short-lived identity cache so both paths are idempotent without
// treating a changed answer as a duplicate.
const handledPollEvents = new Map<string, number>();
const POLL_EVENT_DEDUPE_MS = 10 * 60_000;
function pollEventIdentity(sessionId: string, chatJid: string, pollMsgId: string, voterJid: string, selectedHex: string[], removed: boolean): string {
  const eventPart = removed ? 'removed' : selectedHex.slice().sort().join(',');
  return `${sessionId}:${chatJid}:${pollMsgId}:${voterJid.toLowerCase()}:${eventPart}`;
}
function claimPollEvent(identity: string): boolean {
  const now = Date.now();
  for (const [key, timestamp] of handledPollEvents) {
    if (now - timestamp > POLL_EVENT_DEDUPE_MS) handledPollEvents.delete(key);
  }
  if (handledPollEvents.has(identity)) return false;
  handledPollEvents.set(identity, now);
  return true;
}

// ── Poll Game Engine singleton ───────────────────────────────
// Per-session Game API config: only the current session's own UserConfig is
// consulted. There is no platform-wide or environment-key fallback. The key
// is NEVER logged / exposed in any response or report.
const gameAi = new GameAI({
  getConfig: (sessionId: string) => {
    const telegramId = sessionOwnerMap.get(sessionId);
    if (!telegramId) return null;
    const cfg = loadSessionConfig(telegramId, sessionId);
    // Game credentials are strictly session-owned. Do not fall back to a
    // platform-wide key: that would make Session B accidentally use Session A's
    // provider and violate the isolation contract.
    const apiKey = cfg.gameApiKey;
    if (!apiKey) return null;
    return {
      apiKey,
      model: cfg.gameApiModel,
      endpoint: cfg.gameApiEndpoint,
    };
  },
});

export const pollGameEngine = createPollGameEngine({
  ai: gameAi,
  persist: (snapshot: PollGameSnapshot) => {
    const telegramId = sessionOwnerMap.get(snapshot.scope.sessionId);
    if (!telegramId) return;
    savePollGameSnapshot(telegramId, snapshot.scope.sessionId, snapshot);
  },
});

// Persistent cache for menu URL externalAdReply — fetched once, reused for 24h
const menuAdReplyCache = new Map<string, { title: string; body: string; thumbnailUrl?: string; expires: number }>();

function getMenuAdReply(key: string) {
  const cached = menuAdReplyCache.get(key);
  if (cached && Date.now() < cached.expires) return cached;
  menuAdReplyCache.delete(key);
  return null;
}

function setMenuAdReply(key: string, data: { title: string; body: string; thumbnailUrl?: string }) {
  // Cap cache size to 500 entries to prevent memory exhaustion
  if (menuAdReplyCache.size > 500) {
    const oldestKey = menuAdReplyCache.keys().next().value;
    if (oldestKey) menuAdReplyCache.delete(oldestKey);
  }
  menuAdReplyCache.set(key, { ...data, expires: Date.now() + 24 * 60 * 60 * 1000 });
}



export function registerSessionOwner(sessionId: string, telegramId: string): void {
  sessionOwnerMap.set(sessionId, telegramId);
  // Recover poll games that were active before a restart (timers are re-armed).
  // The restored games keep emitting through the same send path as live games.
  try {
    const snapshots = loadPollGameSnapshots(telegramId, sessionId);
    if (snapshots.length > 0) {
      logger.info('[PollGame] restoring snapshots', { sessionId, count: snapshots.length });
    }
    for (const snap of snapshots) {
      pollGameEngine.restore(snap, async (event) => {
        const socket = getSocket(sessionId);
        if (!socket) return;
        return sendPollGameEvent(socket as WASocket, telegramId, event);
      });
    }
  } catch (err) {
    logger.warn('[PollGame] session restore failed', { sessionId, err: String(err) });
  }
}

export function disposeSessionGames(sessionId: string): void {
  gameManager.disposeSession(sessionId);
  pollGameEngine.disposeSession(sessionId);
}

export function unregisterSessionOwner(sessionId: string): void {
  const telegramId = sessionOwnerMap.get(sessionId);
  sessionOwnerMap.delete(sessionId);
  disposeSessionGames(sessionId);
  if (telegramId) clearPollGameSnapshots(telegramId, sessionId);
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

async function resolveGamePlayer(socket: WASocket, msg: WebMessageInfo): Promise<string | null> {
  const raw = msg.key.participant
    ?? (msg.key.fromMe ? (socket as unknown as { user?: { id?: string } }).user?.id : msg.key.remoteJid)
    ?? '';
  if (!raw) return null;
  const mention = await resolveMention(socket, { jid: raw }).catch(() => null);
  return mention?.jid || (raw.endsWith('@s.whatsapp.net') ? raw : null);
}

async function sendGameResponse(
  socket: WASocket,
  telegramId: string,
  response: GameResponse,
): Promise<void> {
  const options: Record<string, unknown> = {
    sessionId: response.scope.sessionId,
    telegramId,
    forceMentions: true,
    ...(response.mentions.length > 0 ? { extra: { mentions: response.mentions } } : {}),
    ...(response.editKey ? { edit: response.editKey } : {}),
  };
  const result = await PreviewManager.send(socket as any, response.scope.chatJid, response.text, options) as any;
  if (response.editKey && result?.success === false) {
    const fallback = await PreviewManager.send(socket as any, response.scope.chatJid, response.text, {
      sessionId: response.scope.sessionId,
      telegramId,
      forceMentions: true,
      ...(response.mentions.length > 0 ? { extra: { mentions: response.mentions } } : {}),
    }) as any;
    if (fallback?.key) gameManager.attachMessageKey(response.scope, response.gameType, fallback.key);
  } else if (!response.editKey && result?.key) {
    gameManager.attachMessageKey(response.scope, response.gameType, result.key);
  }
}

const POLL_SEND_TIMEOUT_MS = 20_000;

/**
 * Guard a game send with a timeout. A send that never settles (e.g. a
 * boot-time socket still connecting) must not wedge the game engine —
 * the send times out, is logged, and the game continues/finishes.
 */
async function sendGamePayload<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), POLL_SEND_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Send a Poll Game Engine event. Handles poll sends (native timed polls +
 * decryption secret), native-table sends (rankings) and plain text. Returns
 * the sent message key so the engine can bind the poll for vote matching.
 */
async function sendPollGameEvent(
  socket: WASocket,
  telegramId: string,
  event: PollEvent,
): Promise<{ key?: unknown; sent?: boolean } | void> {
  const base = {
    sessionId: event.scope.sessionId,
    telegramId,
    forceMentions: true,
    ...(event.mentions && event.mentions.length > 0 ? { extra: { mentions: event.mentions } } : {}),
  };
  const kind = event.poll ? 'poll' : event.nativeTable ? 'table' : 'text';

  if (event.poll) {
    const result = await sendGamePayload(PreviewManager.send(socket as any, event.scope.chatJid, event.text ?? '', {
      ...base,
      poll: {
        name: event.poll.name,
        values: event.poll.values,
        selectableCount: event.poll.selectableCount,
        ...(event.poll.endDate ? { endDate: event.poll.endDate } : {}),
        ...(event.poll.messageSecret ? { messageSecret: event.poll.messageSecret } : {}),
      },
    })) as any;
    if (!result || result.success === false || !result.key) {
      logger.warn('[PollGame] poll send failed or returned no key', { chatJid: event.scope.chatJid, kind });
      return { sent: false };
    }
    return { key: result.key, sent: true };
  }

  if (event.nativeTable) {
    const result = await sendGamePayload(PreviewManager.send(socket as any, event.scope.chatJid, event.tableFallbackText ?? event.text ?? '', {
      ...base,
      nativeTable: event.nativeTable,
      tableFallbackText: event.tableFallbackText,
    })) as any;
    if (!result || result.success === false) {
      logger.warn('[PollGame] table send failed', { chatJid: event.scope.chatJid, kind });
      return { sent: false };
    }
    return { key: result.key, sent: true };
  }

  const result = await sendGamePayload(PreviewManager.send(socket as any, event.scope.chatJid, event.text ?? '', base)) as any;
  if (!result || result.success === false) {
    logger.warn('[PollGame] text send failed', { chatJid: event.scope.chatJid, kind });
    return { sent: false };
  }
  return { key: result.key, sent: true };
}

/**
 * Per-session Game API setup tutorial (WhatsApp). Mirrors the Telegram
 * admin guide card — Groq is the default provider, Grok is the alt.
 * Keys/models/endpoints are always stored PER SESSION and never shown
 * again after being set.
 */
function gameApiGuideCard(prefix: string): string {
  return successCard(
    'GAME API • SETUP',
    [
      'AI games (.wyr / .quiz) generate content through a per-session provider.',
      '',
      '🅐 *Groq* (default) — free tier',
      '  Key:      gsk_…  (console.groq.com)',
      '  Model:    llama-3.3-70b-versatile',
      '  Endpoint: groq',
      '',
      '🅑 *Grok (xAI)* — alternative',
      '  Key:      xai-…',
      '  Model:    grok-2-latest',
      '  Endpoint: xai',
      '',
      `1) \`${prefix}gameapi <key>\` — set THIS session key`,
      `2) \`${prefix}gameapi model <model>\` — override model`,
      `3) \`${prefix}gameapi endpoint <groq|xai|openai|url>\` — pick provider`,
      `4) \`${prefix}gameapi\` — status (key always hidden)`,
      `5) \`${prefix}wyr\` / \`${prefix}quiz\` in a group to play`,
      '',
      'Each WhatsApp session must set its own key. Credentials never fall back across sessions and are never shown again.',
    ].join('\n')
  );
}

function extractMessageText(message: IMessage | null | undefined): string {
  // Keep command parsing aligned with quoted-payload parsing. Baileys may wrap
  // the incoming command in ephemeral/view-once/document/interactive
  // containers after reconnect or history replay.
  return extractMessageTextAny(message);
}


// ── Main Event Router ─────────────────────────────────────

let getKeyAuthorForUpdate: ((key: { fromMe?: boolean; participantAlt?: string | null; remoteJidAlt?: string | null; participant?: string | null; remoteJid?: string | null }, meId?: string) => string) | null | undefined;
async function resolveGetKeyAuthorForUpdate(): Promise<NonNullable<typeof getKeyAuthorForUpdate> | null> {
  if (getKeyAuthorForUpdate !== undefined) return getKeyAuthorForUpdate;
  try {
    const baileys = await import('@crysnovax/baileys') as { getKeyAuthor?: typeof getKeyAuthorForUpdate };
    getKeyAuthorForUpdate = baileys.getKeyAuthor ?? null;
  } catch {
    getKeyAuthorForUpdate = null;
  }
  return getKeyAuthorForUpdate;
}

export async function handleWAEvent(
  sessionId: string,
  event: keyof BaileysEventMap,
  data: unknown,
  socket: WASocket
): Promise<void> {
  switch (event) {
    // ── Messages ────────────────────────────────────────────
    case 'messages.upsert': {
      await handleMessages(sessionId, data as { messages: WebMessageInfo[]; type: string }, socket);
      return;
    }

    // ── Anti System: group participant events (AntiPromote / AntiDemote / Welcome / Goodbye) ──
    case 'group-participants.update': {
      const telegramId = sessionOwnerMap.get(sessionId);
      if (telegramId) {
        // Baileys emits group-participants.update as a SINGLE object (not an array).
        // Wrap it in an array to support both shapes for forward-compatibility.
        const rawUpdates = data as unknown;
        const updates: Array<{ id: string; participants: unknown[]; action: string; author?: string }> =
          Array.isArray(rawUpdates)
            ? (rawUpdates as Array<{ id: string; participants: unknown[]; action: string; author?: string }>)
            : [rawUpdates as { id: string; participants: unknown[]; action: string; author?: string }];

        for (const update of updates) {
          if (!update?.id) continue;

          // ── BAILEYS 2.7.0 PARTICIPANT FORMAT FIX ──────────────────────────
          // @crysnovax/baileys@2.7.0 changed `participants` from string[] (JID strings)
          // to Object[] ({ id: string, phoneNumber: string, admin?: string }) to support
          // LID-based JIDs.  All downstream consumers (Welcome, Goodbye, AutoBlock,
          // AntiPromote, AntiDemote, patchGroupMetaCache) expect plain JID strings.
          // Normalize here — at the single dispatch boundary — so every feature works
          // without modification.
          //
          // IMPORTANT: the fork exposes `phoneNumber` on LID entries (id: xxx@lid).
          // The real phone JID is PREFERRED over the LID id so downstream features
          // never leak a LID into welcome/goodbye mentions or moderation actions.
          // Backward-compatible: if Baileys ever reverts to strings this no-ops correctly.
          const rawParticipants: unknown[] = update.participants ?? [];
          const participantJids: string[] = normalizeParticipantUpdateJids(rawParticipants);

          logger.debug('[EventHandler] group-participants.update', {
            sessionId,
            groupJid: update.id,
            action: update.action,
            participants: participantJids,
            author: update.author,
          });

          await handleParticipantUpdate(socket, sessionId, telegramId, {
            id: update.id,
            participants: participantJids,
            action: update.action as 'add' | 'remove' | 'promote' | 'demote',
            author: update.author,
          }).catch((err) => {
            logger.warn('[AntiSystem] handleParticipantUpdate error', { err: String(err) });
          });
        }
      }
      return;
    }

    // ── messages.update: delivery/read/played + DELETE-FOR-EVERYONE revokes ──
    // Verified against the installed @crysnovax/baileys fork (Utils/process-message.js
    // REVOKE case): delete-for-everyone arrives here as
    //   { key: { ...originalKey, id: protocolMsg.key.id },
    //     update: { message: null, messageStubType: WAMessageStubType.REVOKE } }
    // NOT as update.protocolMessage. The top-level key carries the ORIGINAL message
    // id — matching the AntiDelete cache — so recovery is keyed off it.
    // The update.protocolMessage shape is kept as a cross-version fallback.
    case 'messages.update': {
      const updates = Array.isArray(data)
        ? (data as Array<{
            key?: { id?: string; remoteJid?: string; participant?: string };
            update?: {
              status?: number;
              message?: unknown;
              messageStubType?: number;
              protocolMessage?: { type?: number; key?: { remoteJid?: string; id?: string; participant?: string } };
            };
          }>)
        : [];
      for (const u of updates) {
        if (u?.key?.id) {
          logger.debug('[Events] messages.update', { sessionId, id: u.key.id, status: u.update?.status });
        }
        const update = u?.update;
        // Fork-native revoke: message nulled + stub type set; top-level key = original.
        const isForkRevoke = update?.message === null && update?.messageStubType !== undefined && !!u?.key?.id;
        // Cross-version revoke: update.protocolMessage.type === 0 (REVOKE).
        // Baileys 2.7.1 can expose a decrypted poll result through
        // messages.update as { key: creationKey, update: { pollUpdates: [...] } }.
        // Prefer this native event when present; the raw pollUpdateMessage path
        // below is retained because this fork's auto-decrypt block is disabled.
        const pollUpdates = (update as { pollUpdates?: Array<{
          pollUpdateMessageKey?: { fromMe?: boolean; participantAlt?: string | null; remoteJidAlt?: string | null; participant?: string | null; remoteJid?: string | null };
          vote?: { selectedOptions?: Array<Uint8Array | Buffer | string> };
          senderTimestampMs?: number;
        }>} | undefined)?.pollUpdates;
        if (pollUpdates?.length && u?.key?.id && u.key.remoteJid) {
          const ownId = (socket as unknown as { user?: { id?: string; lid?: string } }).user?.id ?? '';
          const author = await resolveGetKeyAuthorForUpdate();
          for (const pollUpdate of pollUpdates) {
            const voterKey = pollUpdate.pollUpdateMessageKey;
            const voterJid = author?.(voterKey ?? {}, ownId) ?? voterKey?.participant ?? voterKey?.remoteJid ?? '';
            const selected = (pollUpdate.vote?.selectedOptions ?? []).map((value) => {
              if (typeof value === 'string') return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : Buffer.from(value, 'latin1').toString('hex');
              return Buffer.from(value).toString('hex');
            });
            const owner = (['wyr', 'quiz'] as const)
              .map((gameType) => {
                const game = pollGameEngine.getGame({ sessionId, chatJid: u.key!.remoteJid! }, gameType);
                if (!game) return null;
                const question = game.questions.find((candidate) => {
                  const binding = candidate.pollBinding;
                  if (binding && (
                    binding.sessionId !== sessionId
                    || binding.chatJid !== u.key!.remoteJid
                    || binding.gameId !== game.id
                    || binding.questionId !== candidate.id
                  )) return false;
                  return (binding?.pollMessageKey?.id ?? candidate.pollMsgId) === u.key!.id;
                });
                return question ? { game, question } : null;
              })
              .find((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
            if (!owner) continue;
            const ownerQuestion = owner.question;
            // Single-select polls must resolve to exactly one option of the
            // associated question; never match against another active poll.
            const matchedIndexes = selected.flatMap((digest) => ownerQuestion.options
              .map((option, index) => optionHashHex(option) === digest ? index : -1)
              .filter((index) => index >= 0));
            const uniqueIndexes = [...new Set(matchedIndexes)];
            const questionOption = uniqueIndexes.length === 1 ? uniqueIndexes[0]! : -1;
            if (questionOption >= 0 || selected.length === 0) {
              const removed = selected.length === 0;
              if (!claimPollEvent(pollEventIdentity(sessionId, u.key.remoteJid, u.key.id, voterJid, selected, removed))) continue;
              await pollGameEngine.handleVote({
                scope: { sessionId, chatJid: u.key.remoteJid },
                pollMsgId: u.key.id,
                voterJid,
                vote: {},
                decrypted: { optionIndex: questionOption, selectedHex: selected, removed },
                meId: ownId,
                meLid: (socket as unknown as { user?: { lid?: string } }).user?.lid,
              });
            }
          }
        }
        const proto = update?.protocolMessage;
        const revokeKey = isForkRevoke
          ? { remoteJid: u.key?.remoteJid, id: u.key?.id, participant: u.key?.participant }
          : proto?.type === 0
            ? proto.key
            : null;
        if (revokeKey?.id) {
          const ownerId = sessionOwnerMap.get(sessionId);
          if (ownerId) {
            await handleDeletedKey(socket, sessionId, ownerId, revokeKey).catch((err) => {
              logger.warn('[AntiDelete] revoke recovery error', { err: String(err) });
            });
          }
        }
      }
      return;
    }

    // ── messages.reaction: reaction to any of our messages ──
    case 'messages.reaction': {
      const reactions = Array.isArray(data)
        ? (data as Array<{ key?: { id?: string }; senderId?: string; reaction?: { text?: string } }>)
        : [];
      for (const r of reactions) {
        if (!r?.key?.id) continue;
        noteReaction(sessionId, r.key.id, r.senderId ?? '', r.reaction?.text ?? '');
        logger.debug('[Events] messages.reaction', { sessionId, id: r.key.id, text: r.reaction?.text });
      }
      return;
    }

    // ── messages.delete: message deleted (self / everyone) ──
    // Keys are also fed to the AntiDelete cache recovery — the fork emits both
    // messages.update (REVOKE) and messages.delete for delete-for-everyone.
    case 'messages.delete': {
      const payload = data as unknown;
      const keys: Array<{ remoteJid?: string; id?: string; participant?: string }> = [];
      if (Array.isArray(payload)) {
        keys.push(
          ...(payload as Array<{ key?: { remoteJid?: string; id?: string; participant?: string } }>)
            .map((d) => d?.key ?? {})
        );
      } else {
        const single = payload as { keys?: Array<{ remoteJid?: string; id?: string; participant?: string }> };
        keys.push(...(single?.keys ?? []));
      }
      const deletedIds = keys.map((k) => k?.id).filter((v): v is string => Boolean(v));
      if (deletedIds.length > 0) logger.info('[Events] messages.delete', { sessionId, ids: deletedIds });
      const ownerId = sessionOwnerMap.get(sessionId);
      for (const k of keys) {
        if (k?.id && ownerId) {
          await handleDeletedKey(socket, sessionId, ownerId, k).catch((err) => {
            logger.warn('[AntiDelete] delete-event recovery error', { err: String(err) });
          });
        }
      }
      return;
    }

    // ── Receipts (delivered/read/played confirmations) ──
    case 'messages.receipt-update':
    case 'message-receipt.update': {
      logger.debug('[Events] receipt-update', { sessionId, count: Array.isArray(data) ? data.length : 0 });
      return;
    }

    // ── Media re-upload updates (thumbnails etc.) — no action needed ──
    case 'messages.media-update': {
      logger.debug('[Events] messages.media-update', { sessionId });
      return;
    }

    // ── History sync (disabled via syncFullHistory=false) ──
    case 'messaging-history.set': {
      logger.debug('[Events] messaging-history.set (history sync skipped)', { sessionId });
      return;
    }

    // ── groups.update: subject/description/icon changed → invalidate meta cache ──
    case 'groups.update': {
      const updates = Array.isArray(data)
        ? (data as Array<{ id?: string; subject?: string; desc?: string }>)
        : [];
      for (const g of updates) {
        if (!g?.id) continue;
        try {
          bustGroupMetaCache(socket, g.id);
          setGroupMetaSnapshot(sessionId, g.id, g);
          logger.debug('[Events] groups.update', { sessionId, groupJid: g.id, subject: g.subject });
        } catch (err) {
          logger.warn('[Events] groups.update error', { err: String(err) });
        }
      }
      return;
    }

    // ── presence.update: online/offline/composing tracking (store only, no per-event logs) ──
    case 'presence.update': {
      const upd = data as { id?: string; presences?: Record<string, { lastKnownPresence?: string }> };
      try {
        if (upd?.presences) {
          for (const [jid, p] of Object.entries(upd.presences)) {
            const online =
              p?.lastKnownPresence === 'available' ||
              p?.lastKnownPresence === 'composing' ||
              p?.lastKnownPresence === 'recording';
            setPresence(sessionId, jid, online);
          }
        }
      } catch (err) {
        logger.debug('[Events] presence.update error', { err: String(err) });
      }
      return;
    }

    // ── contacts.update / contacts.upsert: name/avatar/LID mapping refresh ──
    case 'contacts.update':
    case 'contacts.upsert': {
      const contacts = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      if (contacts.length > 0) upsertContacts(sessionId, contacts);
      // Feed the status-jid tracker (contacts.update carries the active-status
      // flag; contacts.upsert contributes known contacts as a fallback list).
      for (const c of contacts) {
        const cid = String((c as { id?: unknown }).id ?? '');
        if (cid) rememberStatusContact(sessionId, cid, Boolean((c as { status?: unknown }).status));
      }
      return;
    }

    // ── Calls: log + optional auto-reject (anti-call) ──
    case 'call': {
      const calls = Array.isArray(data)
        ? (data as Array<{ id?: string; from?: string; status?: string; isVideo?: boolean; isGroup?: boolean }>)
        : [];
      for (const call of calls) {
        if (!call?.id || !call?.from) continue;
        logger.info('[Events] Incoming call', {
          sessionId,
          from: call.from,
          status: call.status,
          isVideo: call.isVideo,
        });
        const telegramId = sessionOwnerMap.get(sessionId);
        if (telegramId && call.status === 'offer') {
          const config = loadSessionConfig(telegramId, sessionId);
          if (config.antiCallEnabled) {
            const reject = (socket as unknown as { rejectCall?: (id: string, from: string) => Promise<unknown> }).rejectCall;
            if (reject) {
              await reject(call.id, call.from).catch((err) =>
                logger.warn('[Events] Call reject failed', { err: String(err) })
              );
            }
          }
        }
      }
      return;
    }

    // ── Blocklist ──
    case 'blocklist.set':
    case 'blocklist.update': {
      logger.debug('[Events] blocklist update', { sessionId, count: Array.isArray(data) ? data.length : 0 });
      return;
    }

    // ── Chats / labels / products / stickers — logged for future features ──
    case 'chats.set':
    case 'chats.update':
    case 'chats.delete':
    case 'labels.association':
    case 'labels.edit':
    case 'product.update':
    case 'sticker.update':
    case 'status.update':
    case 'chat-update': {
      logger.debug('[Events] state change', { sessionId, event });
      return;
    }

    // ── Newsletter (channels) — future-proofing ──
    case 'newsletter.update':
    case 'newsletter.mute':
    case 'newsletter.reaction':
    case 'newsletter.follow':
    case 'newsletter.join':
    case 'newsletter.leave':
    case 'newsletter.view':
    case 'newsletter.delete':
    case 'newsletter.ephemeral': {
      logger.debug('[Events] newsletter event', { sessionId, event });
      return;
    }

    default: {
      logger.debug('[Events] unhandled event', { sessionId, event });
      return;
    }
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

// ── Status Pipeline ───────────────────────────────────────
// Incoming status posts arrive via messages.upsert with
// remoteJid === 'status@broadcast'. Auto-view + optional auto-like.
async function autoHandleStatus(
  sessionId: string,
  telegramId: string,
  msg: WebMessageInfo,
  socket: WASocket
): Promise<void> {
  try {
    if (msg.key?.remoteJid !== 'status@broadcast') return;
    if (msg.key.fromMe) return; // never auto-react to our own posts
    const config = loadSessionConfig(telegramId, sessionId);
    // Auto-view (marks the status as seen)
    if (config.autoStatusView !== false) {
      const read = (socket as unknown as { readMessages?: (keys: unknown[]) => Promise<unknown> }).readMessages;
      if (read) await read([msg.key]).catch(() => undefined);
    }
    // Auto-like with the configured emoji (opt-in)
    if (config.autoStatusLike && config.statusEmoji) {
      await socket
        .sendMessage('status@broadcast', { react: { text: config.statusEmoji, key: msg.key } }, {})
        .catch(() => undefined);
    }

    // ── Personal Engine: auto-download to Saved Messages + native auto-react ──
    await maybeAutoDownloadStatus(socket, sessionId, telegramId, msg);
  } catch (err) {
    logger.debug('[Status] autoHandleStatus error', { err: String(err) });
  }
}

// ── Message Handler ───────────────────────────────────────

async function handleMessages(
  sessionId: string,
  upsert: { messages: WebMessageInfo[]; type: string },
  socket: WASocket
): Promise<void> {
  // The installed Baileys fork can deliver raw pollUpdateMessage entries as
  // either `notify` or `append` (offline/replayed updates). Do not discard an
  // append before inspecting whether it is a poll vote; ordinary append
  // history messages remain ignored below.
  const hasRawPollUpdate = upsert.messages.some((candidate) => Boolean(
    (candidate.message as { pollUpdateMessage?: unknown } | null | undefined)?.pollUpdateMessage
  ));
  if (upsert.type !== 'notify' && !hasRawPollUpdate) return;

  const telegramId = sessionOwnerMap.get(sessionId);
  if (!telegramId) return;

  for (const msg of upsert.messages) {
    if (!msg.message) continue;
    const rawPollUpdate = (msg.message as { pollUpdateMessage?: {
      pollCreationMessageKey?: {
        id?: string | null;
        remoteJid?: string | null;
        fromMe?: boolean | null;
        participant?: string | null;
        participantAlt?: string | null;
      } | null;
      vote?: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null } | null;
      senderTimestampMs?: number | null;
    } | null }).pollUpdateMessage;
    const isRawPollUpdate = Boolean(rawPollUpdate);
    // `append` is admitted only for raw poll updates; do not re-enable normal
    // history-message command processing.
    if (upsert.type !== 'notify' && !isRawPollUpdate) continue;

    // ── Dedupe + store ─────────────────────────────────────────
    // Baileys can re-deliver the same upsert after a reconnect. Raw poll
    // envelopes normally have their own key id, but use a stable poll/voter/
    // timestamp fallback when that envelope id is absent.
    const rawPollKey = rawPollUpdate?.pollCreationMessageKey;
    const rawPollChat = rawPollKey?.remoteJid ?? msg.key?.remoteJid ?? '';
    const rawPollDedupeId = isRawPollUpdate && rawPollKey?.id && rawPollUpdate
      ? `poll-vote:${sessionId}:${rawPollChat}:${rawPollKey.id}:${msg.key?.participant ?? msg.key?.remoteJid ?? ''}:${rawPollUpdate.senderTimestampMs ?? ''}`
      : undefined;
    if (!markSeen(sessionId, msg.key?.id ?? rawPollDedupeId)) continue;
    rememberMessage(sessionId, msg);

    // AntiDelete cache — keep every message so a later revoke can be recovered
    cacheMessage(sessionId, msg);

    // ── AntiDelete: REVOKE arriving via messages.upsert (protocolMessage) ──
    // The fork delivers delete-for-everyone BOTH as a messages.update revoke
    // (handled in the update listener) AND as the raw protocol message here.
    // Its .protocolMessage.key holds the ORIGINAL message key. Recover-once is
    // guaranteed by the engine's cache eviction; consumed before commands.
    const protoMsg = (msg.message as { protocolMessage?: { type?: number; key?: { remoteJid?: string; id?: string; participant?: string } } } | undefined)?.protocolMessage;
    if (protoMsg?.type === 0 && protoMsg.key?.id) {
      await handleDeletedKey(socket, sessionId, telegramId, protoMsg.key).catch((err) => {
        logger.warn('[AntiDelete] upsert-revoke recovery error', { err: String(err) });
      });
      continue;
    }

    // ── Status pipeline: auto-view / auto-like / auto-download / auto-react ──
    // Incoming status posts arrive with remoteJid === 'status@broadcast'. They are
    // consumed here BEFORE anti-checks and command parsing (a contact status must
    // never trigger a command or leak into moderation).
    if (msg.key?.remoteJid === 'status@broadcast') {
      await autoHandleStatus(sessionId, telegramId, msg, socket);
      continue;
    }

    // ── Auto View Once (per chat) ──
    if (!msg.key?.fromMe) {
      await maybeAutoViewOnce(socket, sessionId, telegramId, msg).catch((err) => {
        logger.warn('[AutoVV] handler error', { err: String(err) });
      });
    }

    // ── AutoSend: replies to my statuses asking for the content ──
    if (!msg.key?.fromMe && !msg.key?.remoteJid?.endsWith('@g.us')) {
      const autoSendText = extractMessageText(msg.message);
      if (autoSendText) {
        await maybeAutoSend(socket, sessionId, telegramId, msg, autoSendText).catch((err) => {
          logger.warn('[AutoSend] handler error', { err: String(err) });
        });
      }
    }

    // ── Auto-read incoming 1:1 messages (marks DMs as read instantly) ──
    // Gate off with WA_AUTO_READ=0 if undesired. Status posts are handled
    // by the status pipeline above.
    if (!msg.key?.fromMe && msg.key?.remoteJid?.endsWith('@s.whatsapp.net')) {
      if (process.env.WA_AUTO_READ !== '0') {
        (socket as unknown as { readMessages?: (keys: unknown[]) => Promise<unknown> })
          .readMessages?.([msg.key])
          .catch(() => undefined);
      }
    }

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
            // Central Mention Engine — real phone token + real phone JID in
            // the mentions array, always in sync (never a hand-built @number).
            const mention = await resolveMention(socket, { jid: senderJid });
            const promoteText = mention.token
              ? `✅ ${mention.token} has been promoted to admin.`
              : '✅ The member has been promoted to admin.';
            await PreviewManager.send(socket as any, msgGroupJid, promoteText, {
              ...(mention.jid ? { extra: { mentions: [mention.jid] } } : {}),
              forceMentions: true,
              sessionId,
              telegramId,
            });
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

    // ── Central Interaction Router ──────────────────────────
    // Every interactive reply (button presses, native-list row selections)
    // is routed BEFORE anti-checks so no module can swallow a navigation
    // tap. Handled replies are consumed (continue).
    const interaction = parseInteraction(msg.message);
    if (interaction) {
      const handled = await routeInteraction({
        socket,
        sessionId,
        telegramId,
        msg,
        interaction,
        frozen: isFrozen(sessionId),
      }).catch((err) => {
        logger.warn('[Interaction] routing failed', { err: String(err) });
        return false;
      });
      if (handled) continue;
    }

// ── Poll Game Engine: poll vote updates ─────────────────
// The fork's auto-decrypt block is disabled, so raw pollUpdateMessage
// votes arrive here via messages.upsert. The engine decrypts them with
// the messageSecret we set at poll creation and validates scope / poll
// id / expiry — unknown, expired or ambiguous votes are safely ignored.

// Voter JID extraction uses the fork's OWN getKeyAuthor() (the same
// helper the reference decrypt block used: participantAlt →
// remoteJidAlt → participant → remoteJid) so the decrypt HMAC sign + GCM
// AAD receive the exact key-author bytes the voters used. Lazy singleton
// — resolved once, reused for every vote.
let getKeyAuthorFn: ((key: { fromMe?: boolean; participantAlt?: string | null; remoteJidAlt?: string | null; participant?: string | null; remoteJid?: string | null }, meId?: string) => string) | null | undefined;
async function resolveGetKeyAuthor(): Promise<typeof getKeyAuthorFn> {
  if (getKeyAuthorFn !== undefined) return getKeyAuthorFn;
  try {
    const baileys = await import('@crysnovax/baileys') as { getKeyAuthor?: typeof getKeyAuthorFn };
    getKeyAuthorFn = baileys.getKeyAuthor ?? null;
  } catch {
    getKeyAuthorFn = null;
  }
  return getKeyAuthorFn;
}

    const pollUpdate = rawPollUpdate;

    if (pollUpdate?.pollCreationMessageKey?.id && pollUpdate.vote) {
      try {
        const sockUser = (socket as unknown as { user?: { id?: string; lid?: string } }).user;
        const meId = sockUser?.id ?? '';
        const meLid = sockUser?.lid;
        const pollChatJid = pollUpdate.pollCreationMessageKey.remoteJid ?? msg.key.remoteJid ?? '';
        logger.info('[PollGame] raw poll update received', {
          sessionId,
          upsertType: upsert.type,
          voteMessageId: msg.key.id,
          pollMsgId: pollUpdate.pollCreationMessageKey.id,
          chatJid: pollChatJid,
        });
        // Voter JID extraction mirrors the fork's reference decrypt block
        // (getKeyAuthor ordering: participantAlt → remoteJidAlt →
        // participant → remoteJid) so the HMAC sign + GCM AAD receive the
        // exact key-author bytes the voters used.
        const authorFn = await resolveGetKeyAuthor();
        const baileys = await import('@crysnovax/baileys') as unknown as { jidNormalizedUser?: (jid: string) => string };
        const normalizedMeId = baileys.jidNormalizedUser?.(meId) ?? meId.replace(/:\d+(?=@)/, '');
        const pollCreatorJid = authorFn?.(pollUpdate.pollCreationMessageKey as never, normalizedMeId) ?? '';
        const voterJid = authorFn?.(msg.key as never, normalizedMeId) ?? msg.key.participant ?? msg.key.remoteJid ?? '';
        const trackedQuestions = [
          ...(pollGameEngine.getGame({ sessionId, chatJid: pollChatJid }, 'wyr')?.questions ?? []),
          ...(pollGameEngine.getGame({ sessionId, chatJid: pollChatJid }, 'quiz')?.questions ?? []),
        ];
        const trackedOwner = trackedQuestions.find((question) => (
          question.pollBinding?.pollMessageKey?.id ?? question.pollMsgId
        ) === pollUpdate.pollCreationMessageKey!.id);
        const bindingSecretFingerprint = trackedOwner?.messageSecret
          ? crypto.createHash('sha256').update(Buffer.from(trackedOwner.messageSecret, 'base64')).digest('hex').slice(0, 16)
          : '';
        logger.info('[PollGame] poll crypto context', {
          sessionId,
          pollMsgId: pollUpdate.pollCreationMessageKey.id,
          creatorJid: pollCreatorJid,
          bindingSecretFingerprint,
          creatorKey: {
            fromMe: pollUpdate.pollCreationMessageKey.fromMe ?? false,
            remoteJid: pollUpdate.pollCreationMessageKey.remoteJid ?? '',
            participant: pollUpdate.pollCreationMessageKey.participant ?? '',
            participantAlt: pollUpdate.pollCreationMessageKey.participantAlt ?? '',
          },
          voterJid,
          votePayload: {
            payloadBytes: pollUpdate.vote.encPayload?.byteLength ?? 0,
            ivBytes: pollUpdate.vote.encIv?.byteLength ?? 0,
          },
        });
        if (!trackedOwner) {
          logger.warn('[PollGame] raw poll update has no tracked poll binding', {
            sessionId,
            chatJid: pollChatJid,
            pollMsgId: pollUpdate.pollCreationMessageKey.id,
          });
        }
        if (!trackedOwner) continue;
        // Prefer the exact secret embedded in Baileys' generated poll message.
        // The engine secret is passed into sendMessage, but the returned full
        // WAMessage is authoritative if the fork regenerated/normalized it.
        const storedPoll = loadMessage(sessionId, pollChatJid, pollUpdate.pollCreationMessageKey.id);
        const storedMessage = storedPoll?.message as any;
        const storedIsPollCreation = Boolean(
          storedMessage?.pollCreationMessage
          || storedMessage?.pollCreationMessageV2
          || storedMessage?.pollCreationMessageV3
        );
        const actualSecret = storedMessage?.messageContextInfo?.messageSecret;
        if (
          storedPoll?.key?.id === pollUpdate.pollCreationMessageKey.id
          && storedPoll.key.remoteJid === pollChatJid
          && storedIsPollCreation
          && actualSecret
          && Buffer.from(actualSecret).byteLength === 32
        ) {
          registerPollSecret(
            pollUpdate.pollCreationMessageKey.id,
            Buffer.from(actualSecret),
            { sessionId, chatJid: pollChatJid },
          );
          logger.info('[PollGame] authoritative poll secret loaded', {
            sessionId,
            pollMsgId: pollUpdate.pollCreationMessageKey.id,
            fingerprint: crypto.createHash('sha256').update(Buffer.from(actualSecret)).digest('hex').slice(0, 16),
          });
        }
        const decrypted = await decryptVoteToOption({
          scope: { sessionId, chatJid: pollChatJid },
          pollMsgId: pollUpdate.pollCreationMessageKey.id,
          pollCreatorJid,
          voterJid,
          vote: { encPayload: pollUpdate.vote.encPayload ?? undefined, encIv: pollUpdate.vote.encIv ?? undefined },
          meId,
          meLid,
        }, trackedOwner.options);
        if (decrypted.optionIndex < 0 && !decrypted.removed) continue;
        if (!claimPollEvent(pollEventIdentity(
          sessionId,
          pollChatJid,
          pollUpdate.pollCreationMessageKey.id,
          voterJid,
          decrypted.selectedHex,
          Boolean(decrypted.removed),
        ))) continue;
        await pollGameEngine.handleVote({
          scope: { sessionId, chatJid: pollChatJid },
          pollMsgId: pollUpdate.pollCreationMessageKey.id,
          pollCreatorJid,
          voterJid,
          vote: { encPayload: pollUpdate.vote.encPayload ?? undefined, encIv: pollUpdate.vote.encIv ?? undefined },
          decrypted,
          meId,
          meLid,
        });
      } catch (err) {
        logger.warn('[PollGame] vote ingestion error', { err: String(err) });
      }
      continue; // poll updates are never commands or anti-targets
    }

    // ── Anti System: run BEFORE command dispatch ──────────────
    // Non-throwing; errors in anti modules are isolated internally.
    try {
      const triggered = await runAntiChecks(socket, msg, sessionId, telegramId);
      if (triggered) continue; // skip command parsing for violated messages
    } catch (err) {
      logger.warn('[AntiSystem] runAntiChecks threw', { err: String(err) });
    }

    await processMessage(sessionId, telegramId, msg, socket).catch(async (err) => {
      const errorText = err instanceof Error ? err.message : String(err);
      logger.error('[EventHandler] Message processing error', {
        sessionId,
        err: errorText,
      });

      // ── ERROR REPORT ENGINE ──
      // Internal errors are reported with the canonical OMEGA error report,
      // rendered in the session's response mode (TXT card or native table).
      // Only report for command-like messages in a chat we can reply to.
      const rawCmdText = extractMessageText(msg.message).trim();
      if (rawCmdText && !msg.key.fromMe && msg.key.remoteJid) {
        try {
          const cfg = loadSessionConfig(telegramId, sessionId);
          const reportData = {
            version: BOT_VERSION,
            command: rawCmdText.split(/\s+/)[0]?.replace(/^[^a-zA-Z0-9]+/, '')?.slice(0, 20) || '—',
            message: rawCmdText.slice(0, 80),
            error: errorText.slice(0, 120),
            chat: msg.key.remoteJid,
            platform: platformLabel(),
          };
          const reportTxt = errorReportText(reportData);
          if (cfg.responseMode === 'table') {
            await PreviewManager.send(socket as any, msg.key.remoteJid, reportTxt, {
              nativeTable: errorReportTable(reportData),
              tableFallbackText: reportTxt,
              sessionId,
              telegramId,
            });
          } else {
            await PreviewManager.send(socket as any, msg.key.remoteJid, reportTxt, {
              sessionId,
              telegramId,
            });
          }
        } catch {
          /* error reporting must never throw */
        }
      }
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
  // Use the shared wrapper-aware extractor. After the rebuild/restart path,
  // quoted messages may arrive inside ephemeral/view-once/document-caption
  // containers (and may be attached to media or interactive messages), so a
  // top-level extendedText/image/video lookup silently misses valid quotes.
  const quotedMessage = quotedMessageOf(msg.message);
  const quotedText = extractMessageTextAny(quotedMessage);
  // Stage 1: Extract existing preview from quoted message via PreviewManager
  const quotedPreview = PreviewManager.extractIncomingPreview(quotedMessage);

  // Extract sticker for macro matching — unwrap ephemeral/viewOnce wrappers so
  // disappearing-message chats still trigger sticker macros.
  const _rawMessage = (msg.message ?? {}) as Record<string, any>;
  const stickerMsg = _rawMessage.ephemeralMessage?.message?.stickerMessage
    ?? _rawMessage.viewOnceMessage?.message?.stickerMessage
    ?? _rawMessage.viewOnceMessageV2?.message?.stickerMessage
    ?? msg.message?.stickerMessage;

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

  // Interactive replies (button presses / list row selections) were already
  // routed by the Central Interaction Router in handleMessages().

  // Parse command. Unknown text and unbound stickers are always ignored.
  // ── Prefix-independent Pair ────────────────────────────────
  // Accept .pair, !pair, /pair, #pair, +pair and bare `pair` (with
  // optional leading whitespace). Reject malformed variants such as
  // ..pair, abcpair, nopair, randompair — the regex anchors the word so
  // only a standalone "pair" invocation (optionally with a single
  // leading symbol) ever executes.
  let parsed = text ? parseCommand(text, config) : null;
  if (!parsed && text) {
    const pairMatch = text.match(/^\s*[.!\/#+]?pair(?:\s|$)/i);
    if (pairMatch && !text.match(/^\s*\.\./)) {
      const pairArgs = text.slice(pairMatch[0].length).trim();
      parsed = {
        prefix: config.prefix,
        command: 'pair',
        args: pairArgs ? pairArgs.split(/ +/) : [],
        rawRemainder: pairArgs ? ` ${pairArgs}` : '',
        raw: text,
      };
    }
  }
  if (!parsed && stickerMsg) {
    // Unified fingerprint: fileSha256 fast path (can be Uint8Array or base64
    // string depending on Baileys version), then content-hash fallback for
    // payloads that omit fileSha256 — quoted/forwarded/saved/favourite
    // stickers all resolve reliably, with no double-execution (dedupe above).
    if (stickerMsg.fileSha256) {
      parsed = parseStickerCommand(stickerMsg.fileSha256 as unknown as Buffer, config);
    }
    // Content-hash fallback runs whenever the fast path misses — a binding
    // created from a downloaded buffer (quoted sticker without fileSha256)
    // must still match an incoming sticker that DOES carry a fileSha256, and
    // vice versa. No sticker is ever executed twice: parsed is only set once.
    if (!parsed && stickerMsg) {
      try {
        const baileys = await import('@crysnovax/baileys') as Record<string, any>;
        const fn = baileys.downloadMediaMessage as ((m: unknown, t: string, o: unknown) => Promise<Buffer>) | undefined;
        if (fn) {
          const buffer = await fn(msg, 'buffer', {});
          if (buffer) parsed = parseStickerCommand(buffer, config);
        }
      } catch (err) {
        logger.warn('[Sticker] content-hash fallback failed', { err: String(err) });
      }
    }
    if (parsed) {
      logger.info('[Sticker] Macro matched', { command: parsed.command, stickerHash: parsed.stickerHash });
    }
  }
  if (!parsed) {
    // Ordinary text is only consumed when this chat already has a WCG in
    // progress. The engine rejects spectators and non-current players.
    const gameScope = { sessionId, chatJid: groupJid };
    if (gameManager.hasActive(gameScope)) {
      const playerJid = await resolveGamePlayer(socket, msg);
      if (playerJid) {
        const gameResult = await gameManager.handle({
          scope: gameScope,
          playerJid,
          kind: 'text',
          text,
          onEvent: async (event) => sendGameResponse(socket, telegramId, event),
        });
        if (gameResult) await sendGameResponse(socket, telegramId, gameResult);
      }
    }
    return;
  }

  const { command, args } = parsed;

  // ── Lazy group participant fetch (for hidetag) ────────────
  // Cached per processMessage call; never throws.
  let _groupParticipants: string[] | null = null;
  const getGroupParticipants = async (): Promise<string[]> => {
    if (!isGroup) return [];
    if (_groupParticipants !== null) return _groupParticipants;
    try {
      const meta = await socket.groupMetadata(groupJid);
      const ids = meta.participants.map((p: { id: string }) => p.id);
      // Central Mention Engine: convert LID participant ids to REAL phone JIDs
      // so @<phone> tokens in reply cards match the mentionedJid array — the
      // precondition for native WhatsApp mentions. Unresolvable LIDs fall back
      // to the raw id so silent hidetag pings still reach everyone.
      const sanitized = await sanitizeMentionJids(socket, ids).catch(() => []);
      _groupParticipants = sanitized.length > 0 ? sanitized : ids;
    } catch {
      _groupParticipants = [];
    }
    return _groupParticipants;
  };

  // ── Enriched WhatsApp reply ───────────────────────────────
  // Central URL button attachment for all normal bot responses.
  //
  // RESPONSE MODE ENGINE: when the session is in TABLE mode, any
  // table-friendly card (usage cards, configuration summaries, error
  // reports, module status, anti config, info cards, session summaries)
  // is rendered as the fork's NATIVE table (GenATableUXPrimitive). Chat
  // messages such as warnings, welcomes and moderation notices have no
  // row structure, so tableFromCard() returns null and they stay TXT.
  const baseWhatsAppReply = async (replyText: string, opts?: { suppressPreview?: boolean }): Promise<void> => {
    // Command handlers that already sent their own action/media return an empty
    // string intentionally. Never create an extra blank WhatsApp bubble.
    if (!replyText?.trim()) return;
    const mentions = await getGroupParticipants();
    
    const mode = config.responseMode;
    const table = mode === 'table' ? tableFromCard(replyText) : null;
    if (table) {
      // Native table with graceful fallback to the card if the client
      // rejects the GenAI payload.
      await PreviewManager.send(socket as any, groupJid, replyText, {
        nativeTable: table,
        tableFallbackText: replyText,
        quoted: msg,
        extra: mentions.length > 0 ? { mentions } : undefined,
        sessionId,
        telegramId,
        ...(opts?.suppressPreview ? { suppressPreview: true } : {}),
      });
      return;
    }

    // Formatting and Global Buttons are now handled by the Preview Pipeline.
    // We just pass the raw replyText.
    await PreviewManager.send(socket as any, groupJid, replyText, {
      quoted: msg,
      extra: mentions.length > 0 ? { mentions } : undefined,
      sessionId,
      telegramId,
      ...(opts?.suppressPreview ? { suppressPreview: true } : {}),
    });
  };

  const reply = async (replyText: string, opts?: { suppressPreview?: boolean }): Promise<void> => {
    // Empty command results mean "the handler already responded". This applies
    // to moderation announcements, media recovery, and any future self-sending
    // command, including bridge replies.
    if (!replyText?.trim()) return;
    if (replyOverride) {
      await replyOverride(replyText);
      return;
    }
    await baseWhatsAppReply(replyText, opts);
  };

  type MediaKind = 'image' | 'video' | 'audio' | 'sticker' | 'document';
  type ExtractedMedia = { buffer: Buffer; type: MediaKind; mimeType: string; animated?: boolean; ptt?: boolean; caption?: string; fileName?: string };
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
  const extractStickerId = async (): Promise<string | null> => {
    const quoted = unwrapMessage(getContextInfo()?.quotedMessage);
    const sticker = quoted?.stickerMessage ?? anyMessage.stickerMessage;
    
    // Path 1: Use fileSha256 if available (fastest and most stable)
    if (sticker?.fileSha256) {
      return hashSticker(sticker.fileSha256 as Buffer | Uint8Array | string);
    }

    // Path 2: Download and hash content if SHA is missing
    const sourceMessage = quoted ? ({ key: msg.key, message: quoted } as WebMessageInfo) : msg;
    const buffer = await downloadMessageMedia(sourceMessage);
    if (buffer) return hashSticker(buffer);

    return null;
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
      : m?.stickerMessage ? { type: 'sticker' as const, node: m.stickerMessage }
      : m?.documentMessage ? { type: 'document' as const, node: m.documentMessage }
      : null;
    if (!mediaNode) return null;
    const buffer = await downloadMessageMedia(sourceMessage);
    if (!buffer) return null;
    const mimeType = mediaNode.node?.mimetype
      ?? (mediaNode.type === 'audio' ? 'audio/ogg; codecs=opus'
        : mediaNode.type === 'video' ? 'video/mp4'
        : mediaNode.type === 'sticker' ? 'image/webp'
        : mediaNode.type === 'document' ? 'application/octet-stream'
        : 'image/jpeg');
    return {
      buffer,
      type: mediaNode.type,
      mimeType,
      animated: mediaNode.type === 'sticker' ? Boolean((mediaNode.node as any)?.isAnimated) : undefined,
      ptt: Boolean((mediaNode.node as any)?.ptt),
      caption: (mediaNode.node as any)?.caption,
      fileName: (mediaNode.node as any)?.fileName,
    };
  };
  const sendMenuResponse = async (
    title: string,
    body: string,
    navButtons?: { name: string; buttonParamsJson: string }[],
    enableButtons = true,
    textOnly = false,
    tutorialMedia?: { buffer: Buffer; type: 'image' | 'video'; mimetype: string } | Array<{ buffer: Buffer; type: 'image' | 'video'; mimetype: string }>
  ): Promise<void> => {
    const meta = loadSessionMeta(telegramId, sessionId);
    const tutorialAssets = tutorialMedia
      ? (Array.isArray(tutorialMedia) ? tutorialMedia : [tutorialMedia])
      : [];

    const options: any = {
      quoted: msg,
      sessionId,
      telegramId,
      enableButtons, // Help is text-only; menus can opt into buttons.
    };

    if (navButtons?.length) options.extra = { buttons: navButtons };

    if (tutorialAssets.length > 0) {
      // A tutorial may have both helper image and helper video. Send each
      // persisted asset exactly once; the instructional body is captioned on
      // the first asset only to avoid duplicate bubbles.
      for (const [index, asset] of tutorialAssets.entries()) {
        await PreviewManager.send(socket as any, groupJid, index === 0 ? body : '', {
          ...options,
          media: {
            buffer: asset.buffer,
            type: asset.type,
            mimetype: asset.mimetype,
            caption: index === 0 ? body : '',
          },
        });
      }
      return;
    } else if (!textOnly) {
      const media = await resolveMenuMedia({
        prefix: config.prefix,
        menuTarget: isGroup ? 'group' : 'main',
        status: isFrozen(sessionId) ? 'FROZEN' : 'ONLINE',
        userName: msg.pushName || undefined,
        caption: body,
        config,
        meta,
        socket,
      });
      options.media = {
        buffer: media.buffer,
        type: media.type,
        mimetype: media.mimetype,
        caption: media.caption,
      };
    }

    await PreviewManager.send(socket as any, groupJid, body, options);
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
    const sent = await PreviewManager.send(socket as any, groupJid, initialText, {
      quoted: msg,
      sessionId,
      telegramId,
    }) as any;
    const key = sent?.key;
    return async (nextText: string) => {
      if (!key) {
        await PreviewManager.send(socket as any, groupJid, nextText, { sessionId, telegramId });
        return;
      }
      try {
        await PreviewManager.send(socket as any, groupJid, nextText, {
          edit: key,
          sessionId,
          telegramId,
        });
      } catch {
        await PreviewManager.send(socket as any, groupJid, nextText, { sessionId, telegramId });
      }
    };
  };
  const commandText = (fallback = ''): string => parsed.rawRemainder.trim() || quotedText.trim() || fallback;

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
  const senderNumber = normalizeWhatsAppNumber(sudoCheckJid);
  // Omni Owner bypasses EVERY permission layer automatically (highest tier).
  // BOT-WIDE: applies to every session of every Telegram user (platform config).
  const isOmniSender = isOmniOwnerNumber(telegramId, senderNumber);
  // Live Global Sudo check: per-user Global Sudo changes apply to EXISTING
  // sessions immediately (new sessions merge the list at load time).
  // Global Sudo is a per-Telegram-user account setting (their main hub) —
  // live-checked here so changes apply to existing sessions immediately.
  const isGlobalSudoSender = getGlobalSudoNumbers(telegramId).some(
    (n) => String(n).replace(/\D/g, '') === senderNumber
  );
  const isAuthorized = replyOverride
    || isAuthorizedCommandSender(isOwnerSender, sudoCheckJid, config.sudoNumbers)
    || isOmniSender
    || isGlobalSudoSender;

  if (!isAuthorized) {
    // PRIVATE MODE: Only owners, sudo and authorized users may use commands.
    // Unauthorized users receive NO response (silent).
    //
    // PUBLIC MODE: Anyone may use commands.
    //
    // EXCEPTION: Pair is ALWAYS accessible regardless of mode.
    // PUBLIC MODE is NOT full bot access: ordinary users may only use Pair,
    // Help and Menu navigation. Every other command requires an authorized
    // sender (owner / sudo / omni / authorized list).
    const publicOnlyCommands = new Set(['pair', 'help', 'menu', 'gmenu']);
    const pairAlways = command === 'pair';
    const gameAction = gameManager.hasActive({ sessionId, chatJid: groupJid })
      && (command === 'join' || command === 'ttt');
    const publicAllowed = (config.publicMode && publicOnlyCommands.has(command)) || gameAction;

    if (!pairAlways && !publicAllowed) {
      // COMPLETELY SILENT for everything else
      logger.warn('[EventHandler] Silently ignored unauthorized WhatsApp command', {
        sessionId,
        command,
        sender: normalizeWhatsAppNumber(senderJid),
        mode: config.publicMode ? 'public (pair/help/menu only)' : 'private',
      });
      return;
    }
  }

  logger.info(`[EventHandler] Command: ${command}`, {
    sessionId,
    groupJid,
    sender: isOwnerSender ? 'owner' : normalizeWhatsAppNumber(senderJid),
  });

  // ── Command Dispatch ──────────────────────────────────────

  switch (command) {

    // ── Idea / Feedback ──
    case 'idea': {
      const ideaText = commandText();
      const m = msg.message as any;
      if (!ideaText && !m?.imageMessage && !m?.videoMessage && !m?.audioMessage && !m?.documentMessage) {
        await reply(warningCard('IDEA SYSTEM', 'Please include your suggestion text or media with the .idea command.'));
        return;
      }

      const attachments: any[] = [];
      const media = await extractMedia();
      if (media) {
        // For WhatsApp, we might need to store the media locally since we don't have file IDs like Telegram
        const filename = `idea_${Date.now()}_${Math.floor(Math.random() * 1000)}.${media.mimeType.split('/')[1]}`;
        const filePath = path.join(process.cwd(), 'workspaces', '_platform', 'media', filename);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, media.buffer);
        attachments.push({ type: media.type, filePath, mimeType: media.mimeType });
      }

      addIdea({
        platform: 'whatsapp',
        whatsappNumber: normalizeWhatsAppNumber(senderJid),
        username: (socket as any).contacts?.[senderJid || '']?.name || (socket as any).contacts?.[senderJid || '']?.notify || normalizeWhatsAppNumber(senderJid || ''),
        message: ideaText,
        attachments,
      });

      await reply(successCard('IDEA RECEIVED', 'Thank you! Your suggestion has been sent to the administrator.'));
      return;
    }

    // ── Ping ──
    case 'ping': {
      // ONE response only. Latency is measured internally (a ⚡ reaction on
      // the triggering message round-trips to the WhatsApp server) and the
      // final card is sent in a single message — no fake loading bubble.
      const startTime = Date.now();
      let latencyMs = 0;
      try {
        await socket.sendMessage(groupJid, {
          react: { text: '⚡', key: msg.key },
        });
        latencyMs = Date.now() - startTime;
      } catch {
        // Reactions unsupported/blocked — fall back to message transit time.
        const ts = Number(msg.messageTimestamp ?? 0);
        if (ts > 0) latencyMs = Math.min(Math.max(Date.now() - ts * 1000, 0), 99999);
      }

      const uptime = process.uptime();
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s_uptime = Math.floor(uptime % 60);

      const status = isFrozen(sessionId) ? 'FROZEN' : 'ONLINE';
      const runtime = `${h}h ${m}m ${s_uptime}s`;
      const ram = `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB`;
      // Native rich-response table (GenATableUXPrimitive) — the fork's native
      // table component. Falls back to the compact card if the client rejects
      // the GenAI payload, so ping ALWAYS produces exactly one response.
      const card = pingCard({
        latency: latencyMs,
        sessionId,
        status,
        runtime,
        ram,
        platform: process.platform,
        version: '1.0.0',
      });
      await PreviewManager.send(socket as any, groupJid, card, {
        nativeTable: pingTableData(sessionId, status, {
          latencyMs,
          runtime,
          ram,
          platform: process.platform,
          version: '1.0.0',
        }),
        tableFallbackText: card,
        quoted: msg,
        sessionId,
        telegramId,
      });
      break;
    }

    // ── Menu / Help ──
    // .menu / .gmenu → navigation hub dashboard (status, prefix, response
    //                  mode, timezone, date, time, session) with ONE native
    //                  quick_reply button per category.
    // .help <command> → detailed single-command card (Description, Usage,
    //                  Parameters, Examples, Aliases, Required permissions).
    // .help          → opens the navigation hub (menu only navigates).
    case 'menu':
    case 'help':
    case 'gmenu': {
      const menuTarget: 'main' | 'group' = isGroup || command === 'gmenu' ? 'group' : 'main';
      const known = ALL_COMMANDS;
      const hubOpts = {
        responseMode: config.responseMode,
        timezone: config.timezone,
        status: isFrozen(sessionId) ? 'FROZEN' : 'ONLINE',
        userName: msg.pushName || undefined,
      };

      if (command === 'help') {
        const requestedPage = args[0] && /^\d+$/u.test(args[0]) ? Number(args[0]) : 1;
        if (!args[0] || /^\d+$/u.test(args[0])) {
          const help = helpPageText(config.prefix, requestedPage, 'all', known);
          await sendMenuResponse(`HELP ${requestedPage}`, help.text, undefined, false, true);
          break;
        }
        if (MENU_CATALOG[args[0].toLowerCase()]) {
          // .help <command> → detailed single-command card
          const { generateWhatsAppHelp } = await import('../services/help.js');
          const detail = generateWhatsAppHelp(config.prefix, menuTarget === 'group', args[0].toLowerCase());
          // Tutorial attachment (platform-wide): if the admin attached a
          // tutorial image/video to this command, attach it to the help card.
          const { getTutorial } = await import('../services/tutorials.js');
          const tutorial = getTutorial(args[0].toLowerCase());
          let tutorialMedia: Array<{ buffer: Buffer; type: 'image' | 'video'; mimetype: string }> = [];
          if (tutorial) {
            try {
              const { readTutorialMediaAssets } = await import('../services/tutorials.js');
              tutorialMedia = readTutorialMediaAssets(args[0].toLowerCase()).map((media) => ({
                buffer: media.buffer,
                type: media.type,
                mimetype: media.mimeType,
              }));
            } catch (err) {
              logger.warn('[Help] tutorial media read failed', { command: args[0], err: String(err) });
            }
          }
          await sendMenuResponse(`HELP: ${args[0].toUpperCase()}`, detail, undefined, false, true, tutorialMedia);
          break;
        }
      }

      // .menu / .gmenu → navigation hub dashboard with category buttons.
      await sendMenuResponse(
        'NAVIGATION',
        renderNavHub(config.prefix, menuTarget, known, hubOpts),
        navHubButtons(menuTarget)
      );
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
        sudoCount: (config.sudoNumbers ?? []).filter((n) => {
          const clean = String(n).replace(/\D/g, '');
          // Global Sudo / Omni Owner counts stay hidden from session info.
          return !getGlobalSudoNumbers(telegramId).some((g) => String(g).replace(/\D/g, '') === clean)
            && !getOmniOwnerNumbers(telegramId).some((o) => String(o).replace(/\D/g, '') === clean);
        }).length,
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

    // ── Session Management ──
    // ── Session Profile / Workspace Controls ───────────────────
    // These mirror Telegram's per-session controls. Session switching,
    // Join Manager, and My Groups are intentionally not duplicated here:
    // WhatsApp already runs in the selected session and `groups` provides
    // ordinary group discovery without another submenu.
    case 'setname': {
      const value = commandText();
      if (!value) {
        await reply(warningCard('NAME REQUIRED', `Usage: ${config.prefix}setname <display name>`));
        break;
      }
      try {
        await (socket as unknown as { updateProfileName(name: string): Promise<void> }).updateProfileName(value.trim());
        await reply(successCard('NAME UPDATED', `WhatsApp display name set to: ${value.trim()}`));
      } catch (err) {
        await reply(errorCard('SET NAME FAILED', String(err)));
      }
      break;
    }

    case 'setbio': {
      const value = commandText();
      if (!value) {
        await reply(warningCard('BIO REQUIRED', `Usage: ${config.prefix}setbio <bio text>`));
        break;
      }
      try {
        await (socket as unknown as { updateProfileStatus(bio: string): Promise<void> }).updateProfileStatus(value.trim());
        await reply(successCard('BIO UPDATED', `WhatsApp bio set to: ${value.trim()}`));
      } catch (err) {
        await reply(errorCard('SET BIO FAILED', String(err)));
      }
      break;
    }

    case 'setpfp':
    case 'getpfp':
    case 'removepfp': {
      const user = (socket as unknown as { user?: { id?: string; lid?: string } }).user;
      const rawOwnId = user?.id ?? user?.lid ?? '';
      const ownIdentity = await resolveIdentity(socket, rawOwnId);
      const ownJid = ownIdentity.jid;
      if (!ownJid || ownJid.endsWith('@lid')) {
        await reply(errorCard('PFP FAILED', 'The connected WhatsApp identity is not available yet.'));
        break;
      }
      if (command === 'setpfp') {
        const media = await extractMedia();
        if (!media || media.type !== 'image') {
          await reply(warningCard('REPLY TO IMAGE', `Reply to an image with ${config.prefix}setpfp. The original image is sent in HD without bot-side cropping.`));
          break;
        }
        try {
          await updateSessionProfilePicture(socket as any, ownJid, media.buffer);
          await reply(successCard('PROFILE PICTURE UPDATED', 'The original image bytes were sent with WhatsApp HD enabled; no bot-side crop was applied.'));
        } catch (err) {
          await reply(errorCard('SET PFP FAILED', String(err)));
        }
      } else if (command === 'getpfp') {
        const buffer = await profilePicBuffer(socket, ownJid);
        if (!buffer) {
          await reply(warningCard('NO PROFILE PICTURE', 'WhatsApp did not return a profile picture for this session.'));
          break;
        }
        await PreviewManager.send(socket as any, groupJid, 'PROFILE PICTURE', {
          media: { buffer, type: 'image', mimetype: 'image/jpeg', caption: '🖼 PROFILE PICTURE' },
          quoted: msg,
          sessionId,
          telegramId,
        });
      } else {
        try {
          await (socket as unknown as { removeProfilePicture(jid: string): Promise<void> }).removeProfilePicture(ownJid);
          await reply(successCard('PROFILE PICTURE REMOVED', 'Your WhatsApp profile picture has been removed.'));
        } catch (err) {
          await reply(errorCard('REMOVE PFP FAILED', String(err)));
        }
      }
      break;
    }

    case 'collect': {
      const sub = args[0]?.toLowerCase();
      const meta = loadSessionMeta(telegramId, sessionId);
      if (!sub || !['on', 'off', 'status'].includes(sub)) {
        await reply(asciiBox({
          title: 'LINK COLLECTION',
          emoji: '🔗',
          rows: [['Status', meta?.linkCollectionEnabled ? 'Enabled' : 'Disabled'], ['Collected', String(meta?.linksCollected ?? 0)], ['Usage', `${config.prefix}collect <on|off>`]],
          footer: 'Invite links are collected silently for this WhatsApp session and saved to the main bucket.',
        }));
        break;
      }
      if (sub !== 'status') updateSessionMeta(telegramId, sessionId, { linkCollectionEnabled: sub === 'on' });
      const enabled = sub === 'status' ? Boolean(meta?.linkCollectionEnabled) : sub === 'on';
      await reply(successCard('LINK COLLECTION', `${enabled ? 'Enabled' : 'Disabled'} for this WhatsApp session.`, [['Status', enabled ? 'On' : 'Off'], ['Collected', String(meta?.linksCollected ?? 0)]]));
      break;
    }

    case 'autopromo': {
      const sub = args[0]?.toLowerCase();
      const { getSessionJob, addLink, removeLink, removeJob, runJobNow } = await import('../services/auto-promote.js');
      const job = getSessionJob(telegramId, sessionId);
      if (!sub || sub === 'status' || sub === 'list') {
        await reply(asciiBox({
          title: 'AUTO-PROMOTE',
          emoji: '📅',
          rows: job ? [['Links', String(job.links.length)], ['Days', String(job.days)], ['Ends', new Date(job.endsAt).toLocaleDateString()], ['Usage', `${config.prefix}autopromo add <invite-link> <days>`]] : [['Status', 'Not scheduled'], ['Usage', `${config.prefix}autopromo add <invite-link> <days>`]],
          footer: job?.links.map((link, index) => `${index + 1}. ${link}`).join('\n') || 'No per-session auto-promote links scheduled.',
        }));
        break;
      }
      if (sub === 'off' || sub === 'remove') {
        removeJob(telegramId, sessionId);
        await reply(successCard('AUTO-PROMOTE DISABLED', 'The per-session auto-promote schedule was removed.'));
        break;
      }
      if (sub === 'run') {
        if (!job) { await reply(warningCard('NO AUTO-PROMOTE JOB', `Use ${config.prefix}autopromo add <invite-link> <days> first.`)); break; }
        await runJobNow(telegramId, sessionId);
        await reply(successCard('AUTO-PROMOTE STARTED', 'The current scheduled run was started.'));
        break;
      }
      if (sub === 'remove-link') {
        const index = Number(args[1]);
        if (!Number.isInteger(index) || index < 1) { await reply(warningCard('INDEX REQUIRED', `Usage: ${config.prefix}autopromo remove-link <number>`)); break; }
        if (!job || index > job.links.length) {
          await reply(warningCard('INDEX NOT FOUND', `This session has ${job?.links.length ?? 0} scheduled link(s).`));
          break;
        }
        removeLink(telegramId, sessionId, index - 1);
        await reply(successCard('AUTO-PROMOTE LINK REMOVED', `Removed link #${index} from this session.`));
        break;
      }
      if (sub === 'add') {
        const link = args[1] ?? '';
        const days = Number(args[2]);
        if (!link || !link.includes('chat.whatsapp.com/') || !Number.isInteger(days) || days < 1 || days > 30) {
          await reply(warningCard('INVALID AUTO-PROMOTE', `Usage: ${config.prefix}autopromo add <invite-link> <days>\nDays must be between 1 and 30.`));
          break;
        }
        const created = addLink(telegramId, sessionId, link, days);
        await reply(successCard('AUTO-PROMOTE SCHEDULED', `Link added to this session for ${days} day(s).`, [['Queue', `${created.links.length}/24`], ['Ends', new Date(created.endsAt).toLocaleDateString()]]));
        break;
      }
      await reply(warningCard('AUTO-PROMOTE USAGE', `${config.prefix}autopromo add <invite-link> <days>\n${config.prefix}autopromo status\n${config.prefix}autopromo run\n${config.prefix}autopromo off`));
      break;
    }

    case 'wainfo': {
      const query = commandText();
      if (!query) {
        await reply(warningCard('TARGET REQUIRED', `Usage: ${config.prefix}wainfo <number|JID|group invite link>`));
        break;
      }
      try {
        const sock = socket as unknown as {
          fetchStatus(...jids: string[]): Promise<Array<{ id?: string; status?: string }> | null>;
          groupMetadata(jid: string): Promise<{ subject: string; desc?: string; participants: { id: string; admin?: string | null }[]; creation?: number }>;
          groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>;
        };
        let targetJid = query.trim();
        if (targetJid.includes('chat.whatsapp.com/')) {
          const code = targetJid.split('chat.whatsapp.com/')[1]?.split(/[/?]/)[0] ?? '';
          const invite = code ? await sock.groupGetInviteInfo(code) : null;
          targetJid = invite?.id ?? targetJid;
        } else if (!targetJid.includes('@')) {
          const digits = targetJid.replace(/[^0-9]/g, '');
          if (!digits) throw new Error('Invalid number, JID, or invite link.');
          targetJid = `${digits}@s.whatsapp.net`;
        }
        const picture = await profilePicBuffer(socket, targetJid);
        let infoText: string;
        if (targetJid.endsWith('@g.us')) {
          const group = await sock.groupMetadata(targetJid);
          infoText = asciiBox({ title: 'WHATSAPP GROUP INFO', emoji: '🔍', rows: [['Name', group.subject], ['JID', targetJid], ['Members', String(group.participants.length)], ...(group.creation ? [['Created', new Date(group.creation * 1000).toLocaleDateString()] as [string, string]] : []), ...(group.desc ? [['Description', group.desc] as [string, string]] : [])] });
        } else {
          const status = await sock.fetchStatus(targetJid).catch(() => null);
          const contact = (sock as unknown as { store?: { contacts?: Record<string, { name?: string; notify?: string }> } }).store?.contacts?.[targetJid];
          infoText = asciiBox({ title: 'WHATSAPP CONTACT INFO', emoji: '🔍', rows: [['Number', `+${targetJid.split('@')[0] ?? targetJid}`], ...(contact?.name || contact?.notify ? [['Name', contact.name ?? contact.notify ?? ''] as [string, string]] : []), ...((status?.[0]?.status) ? [['Bio', status[0].status] as [string, string]] : [])] });
        }
        if (picture) {
          await PreviewManager.send(socket as any, groupJid, infoText, { media: { buffer: picture, type: 'image', mimetype: 'image/jpeg', caption: infoText }, quoted: msg, sessionId, telegramId });
        } else {
          await reply(infoText);
        }
      } catch (err) {
        await reply(errorCard('WA INFO FAILED', String(err)));
      }
      break;
    }

    case 'creategc': {
      const raw = parsed.rawRemainder.trim() || quotedText.trim();
      const [name, description = ''] = raw.split('|').map((part) => part.trim());
      if (!name) {
        await reply(warningCard('GROUP NAME REQUIRED', `Usage: ${config.prefix}creategc <name> | <desc>`));
        break;
      }
      try {
        const media = await extractMedia();
        const rawOwnId = (socket as unknown as { user?: { id?: string; lid?: string } }).user?.id
          ?? (socket as unknown as { user?: { id?: string; lid?: string } }).user?.lid
          ?? '';
        const ownIdentity = await resolveIdentity(socket, rawOwnId);
        const ownJid = ownIdentity.jid;
        if (!ownJid || ownJid.endsWith('@lid')) throw new Error('Connected WhatsApp phone identity is unavailable.');
        const created = await (socket as unknown as { groupCreate(subject: string, participants: string[]): Promise<{ id: string }> }).groupCreate(name, [ownJid]);
        if (description) await (socket as unknown as { groupUpdateDescription(jid: string, desc: string): Promise<void> }).groupUpdateDescription(created.id, description).catch(() => {});
        if (media?.type === 'image') await (socket as unknown as { updateProfilePicture(jid: string, content: Buffer, opts?: { hd?: boolean }): Promise<void> }).updateProfilePicture(created.id, media.buffer, { hd: true }).catch(() => {});
        const invite = await (socket as unknown as { groupInviteCode(jid: string): Promise<string> }).groupInviteCode(created.id);
        await reply(successCard('GROUP CREATED', `Created ${name}.`, [['JID', created.id], ['Invite', `https://chat.whatsapp.com/${invite}`], ['Picture', media?.type === 'image' ? 'HD original image' : 'Not set']]));
      } catch (err) {
        await reply(errorCard('CREATE GROUP FAILED', String(err)));
      }
      break;
    }

    case 'ls': {
      const { cmdListSessions } = await import('./commands/session-mgmt.js');
      await reply(await cmdListSessions(telegramId));
      break;
    }

    case 'curr': {
      const { cmdSessionInfo } = await import('./commands/session-mgmt.js');
      await reply(await cmdSessionInfo(telegramId, sessionId));
      break;
    }

    case 'sinfo': {
      const targetId = args[0] || sessionId;
      const { cmdSessionInfo } = await import('./commands/session-mgmt.js');
      await reply(await cmdSessionInfo(telegramId, targetId));
      break;
    }

    case 'restart': {
      const targetId = args[0] || sessionId;
      const { cmdRestartSession } = await import('./commands/session-mgmt.js');
      await reply(await cmdRestartSession(telegramId, targetId));
      break;
    }

    case 'disconnect': {
      const targetId = args[0] || sessionId;
      const { cmdDisconnectSession } = await import('./commands/session-mgmt.js');
      await reply(await cmdDisconnectSession(telegramId, targetId));
      break;
    }

    case 'delete': {
      const targetId = args[0];
      if (!targetId) { await reply(warningCard('SESSION ID REQUIRED', `Usage: ${config.prefix}delete <id>`)); break; }
      const { cmdDeleteSession } = await import('./commands/session-mgmt.js');
      await reply(await cmdDeleteSession(telegramId, targetId));
      break;
    }

    case 'rename': {
      const targetId = args[0];
      const newLabel = args.slice(1).join(' ');
      if (!targetId || !newLabel) { await reply(warningCard('ID & NAME REQUIRED', `Usage: ${config.prefix}rename <id> <name>`)); break; }
      const { cmdRenameSession } = await import('./commands/session-mgmt.js');
      await reply(await cmdRenameSession(telegramId, targetId, newLabel));
      break;
    }

    case 'freeze': {
      const targetId = args[0] || sessionId;
      const { cmdFreezeSession } = await import('./commands/session-mgmt.js');
      await reply(await cmdFreezeSession(targetId));
      break;
    }

    case 'unfreeze': {
      const targetId = args[0] || sessionId;
      const { cmdUnfreezeSession } = await import('./commands/session-mgmt.js');
      await reply(await cmdUnfreezeSession(targetId));
      break;
    }

    case 'switch': {
      await reply(warningCard('SWITCH NOT SUPPORTED', 'To switch sessions, please use the Telegram bot or send a command from the other session.', [], 'SESSION MANAGER'));
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

    // ── Public / Private Mode ──
    // .setmode public  → anyone may use commands
    // .setmode private → only owners, sudo and authorized users (Pair always accessible)
    // .public on|off   → legacy alias
    case 'setmode':
    case 'public': {
      const sub = args[0]?.toLowerCase();
      const enabled = sub === 'public' || sub === 'on' ? true
        : sub === 'private' || sub === 'off' ? false
        : undefined;
      if (enabled !== undefined) {
        updateSessionConfig(telegramId, sessionId, { publicMode: enabled });
        await reply(successCard('ACCESS MODE', `Session is now ${bold(enabled ? 'PUBLIC' : 'PRIVATE')}.`, [
          ['Mode', enabled ? '🌍 Public' : '🔒 Private'],
          ['Access', enabled ? 'Pair, Help & Menu for everyone' : 'Owners, sudo & authorized only'],
          ['Pair', 'Always accessible'],
        ]));
      } else {
        await reply(asciiBox({
          title: 'ACCESS MODE',
          emoji: '🌍',
          rows: [
            ['Current', config.publicMode ? '🌍 PUBLIC' : '🔒 PRIVATE'],
            ['Usage', `${config.prefix}setmode <public|private>`],
            ['Public', 'Pair, Help & Menu only'],
            ['Private', 'Owners, sudo & authorized only'],
            ['Pair', 'Always accessible in both modes'],
          ],
        }));
      }
      break;
    }

    // ── Response Mode Engine ──
    // .swresponse        → show current mode
    // .swresponse txt    → every table-friendly response renders as TXT
    // .swresponse table  → every table-friendly response renders as the native table
    case 'swresponse': {
      const mode = args[0]?.toLowerCase();
      if (mode === 'txt' || mode === 'table') {
        updateSessionConfig(telegramId, sessionId, { responseMode: mode });
        await reply(successCard('RESPONSE MODE', `All responses now render in ${bold(mode.toUpperCase())} mode.`, [
          ['Mode', mode === 'table' ? '📊 Native table' : '📝 Text'],
          ['Scope', 'Usage cards, configs, errors, module status, info cards'],
        ]));
      } else {
        await reply(asciiBox({
          title: 'RESPONSE MODE',
          emoji: '🎛️',
          rows: [
            ['Current', config.responseMode === 'table' ? '📊 TABLE' : '📝 TXT'],
            ['Usage', `${config.prefix}swresponse <txt|table>`],
            ['TXT', 'Text response cards'],
            ['TABLE', 'Native Baileys table (GenATableUXPrimitive)'],
          ],
        }));
      }
      break;
    }

    // ── Timezone ──
    // .settimezone <IANA> — stored per session, used by every feature.
    case 'settimezone': {
      const tz = args.join(' ').trim();
      if (!tz) {
        await reply(asciiBox({
          title: 'TIMEZONE',
          emoji: '🕐',
          rows: [
            ['Current', config.timezone || 'Server default'],
            ['Usage', `${config.prefix}settimezone <IANA>`],
            ['Example', `${config.prefix}settimezone Africa/Lagos`],
          ],
        }));
        break;
      }
      // Validate the IANA zone name via Intl — invalid zones are rejected.
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
      } catch {
        await reply(errorCard('INVALID TIMEZONE', `${bold(tz)} is not a valid IANA timezone.\nExamples: Africa/Lagos, Europe/London, America/New_York`));
        break;
      }
      updateSessionConfig(telegramId, sessionId, { timezone: tz });
      await reply(successCard('TIMEZONE SET', `All timestamps now use ${bold(tz)}.`, [['Timezone', tz]]));
      break;
    }

    case 'publicresponse': {
      const response = args.join(' ').trim();
      if (!response) {
        await reply(asciiBox({
          title: 'PUBLIC RESPONSE',
          emoji: '🚫',
          rows: [
            ['Current', config.permissionDeniedResponse || 'None'],
            ['Usage', `${config.prefix}publicresponse <text>`],
          ],
        }));
        break;
      }
      updateSessionConfig(telegramId, sessionId, { permissionDeniedResponse: response });
      await reply(successCard('RESPONSE UPDATED', 'Public permission denied response updated.', [['New response', response]]));
      break;
    }

    // ── Tag Reply Toggle ──
    case 'tagreply': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'on' || sub === 'off') {
        const enabled = sub === 'on';
        updateSessionConfig(telegramId, sessionId, { tagReply: enabled });
        await reply(successCard('TAG REPLY', `Tagging in replies is now ${bold(sub.toUpperCase())}.`, [
          ['Status', enabled ? '✅ Enabled' : '❌ Disabled'],
        ]));
      } else {
        await reply(asciiBox({
          title: 'TAG REPLY',
          emoji: '🏷️',
          rows: [
            ['Current', config.tagReply ? '✅ ON' : '❌ OFF'],
            ['Usage', `${config.prefix}tagreply <on|off>`],
          ],
        }));
      }
      break;
    }

    // ── QC — Quote/Custom Text Sticker ──
    case 'qc': {
      const qcText = commandText();
      if (!qcText) {
        await reply(warningCard('QC STICKER', `Usage: ${config.prefix}qc [text]`, [], 'QC STICKER'));
        break;
      }
      const { cmdQcSticker } = await import('./commands/qc-sticker.js');
      await cmdQcSticker(socket, telegramId, sessionId, groupJid, qcText, {
        packname: config.stickerPackName,
        author: config.stickerAuthor,
      });
      break;
    }

    // ── TG — Telegram Sticker Downloader ──
    case 'tg': {
      const { cmdTgSticker } = await import('./commands/tg-sticker.js');
      await cmdTgSticker(socket, telegramId, sessionId, groupJid, commandText(), {
        packname: config.stickerPackName,
        author: config.stickerAuthor,
      });
      break;
    }

    case 'sticker': {
      const media = await extractMedia();
      if (!media || (media.type !== 'image' && media.type !== 'video')) {
        await reply(warningCard('REPLY TO MEDIA', `Reply to an image or video with ${config.prefix}sticker to convert it.`, [], 'STICKER ENGINE'), { suppressPreview: true });
        break;
      }
      const { cmdSticker } = await import('./commands/sticker.js');
      await cmdSticker(socket, telegramId, sessionId, groupJid, media as any, {
        packname: config.stickerPackName,
        author: config.stickerAuthor,
      });
      break;
    }

    case 'setpackname': {
      const name = args.join(' ').trim();
      if (!name) {
        await reply(warningCard('NAME REQUIRED', `Usage: ${config.prefix}setpackname [name]`, [], 'STICKER ENGINE'));
        break;
      }
      updateSessionConfig(telegramId, sessionId, { stickerPackName: name });
      await reply(successCard('PACKNAME UPDATED', `Sticker pack name set to: ${bold(name)}`, [], 'STICKER ENGINE'));
      break;
    }

    case 'setauthor': {
      const name = args.join(' ').trim();
      if (!name) {
        await reply(warningCard('NAME REQUIRED', `Usage: ${config.prefix}setauthor [name]`, [], 'STICKER ENGINE'));
        break;
      }
      updateSessionConfig(telegramId, sessionId, { stickerAuthor: name });
      await reply(successCard('AUTHOR UPDATED', `Sticker author set to: ${bold(name)}`, [], 'STICKER ENGINE'));
      break;
    }

    // ── Set Sticker Command ──
    case 'setcmd':
    case 'delcmd':
    case 'editcmd': {
      const quotedStickerHash = await extractStickerId() ?? undefined;

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
      const actionLabel = command === 'editcmd' ? 'UPDATED' : 'BOUND';
      await reply(successCard(`STICKER ${actionLabel}`, 'The macro is active — send that sticker to execute the command.', [
        ['Hash', hash.slice(0, 12) + '…'],
        ['Command', normalizedBinding],
      ]));
      break;
    }

    case 'listcmd': {
      const macros = config.stickerMacros ?? {};
      const keys = Object.keys(macros);
      if (keys.length === 0) {
        await reply(warningCard('NO STICKER COMMANDS', 'You haven\'t bound any stickers to commands yet.'));
        break;
      }
      
      const rows = keys.map((k, i) => [`#${i + 1}`, `${k.slice(0, 8)}… → ${macros[k]}`]);
      await reply(asciiBox({
        title: 'STICKER COMMANDS',
        emoji: '🎭',
        rows: rows as any,
        footer: `Total: ${keys.length} mappings`,
      }));
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
      const meta = loadSessionMeta(telegramId, sessionId);
      if (meta?.menuMedia?.filePath && fs.existsSync(meta.menuMedia.filePath)) {
        try { fs.unlinkSync(meta.menuMedia.filePath); } catch {}
      }
      updateSessionMeta(telegramId, sessionId, { menuMedia: null });
      await reply(successCard('MENU MEDIA REMOVED', 'Menus restored to the default text-only layout.'));
      break;
    }

    // ── Sudo Access ──
    case 'sudo': {
      // Show session sudo only — Global Sudo and Omni Owner are hidden from
      // normal session users (visible only to the admin who configured them).
      const global = getGlobalSudoNumbers(telegramId);
      const omni = getOmniOwnerNumbers(telegramId);
      const hidden = new Set([...global, ...omni].map((n) => n.replace(/\D/g, '')));
      const sudo = (config.sudoNumbers ?? []).filter((n) => !hidden.has(n.replace(/\D/g, '')));
      const isAdminView = isOmniSender || isOwnerSender;
      const list = isAdminView ? [...config.sudoNumbers ?? []] : sudo;
      await reply(sudoListCard(list));
      break;
    }

    // ── Global Sudo & Omni Owner ──
    // These are GLOBAL account settings and live ONLY in the Telegram
    // Settings panel (stored per Telegram user, applied to every session
    // they pair). They are intentionally NOT exposed as WhatsApp commands:
    // a WhatsApp session only controls itself; the Telegram account owns
    // the global layers. Never shown in public session information.

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

      let pfpBuffer: Buffer | null = null;
      let bio = 'Not set';
      try {
        const { fetchProfilePicture } = await import('../whatsapp/socket-manager.js');
        pfpBuffer = await fetchProfilePicture(sessionId, subjectJid);
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
        ['Profile Pic', pfpBuffer ? '✅ Attached below' : '❌ Private / Not set'],
      ];
      if (infoTarget?.lid) {
        infoRows.push(['LID', infoTarget.lid]);
      }
      if (!infoTarget) {
        infoRows.unshift(['Display Name', msg.pushName ?? 'Unknown']);
      }

      const boxOptions: any = {
        title: 'USER INFO',
        emoji: '👤',
        rows: infoRows,
        footer: infoTarget
          ? `JID is always used for actions — LID shown separately when available.`
          : 'Your own session identity',
      };

      const infoText = asciiBox(boxOptions);
      const infoMentions = await getGroupParticipants();
      if (pfpBuffer) {
        await PreviewManager.send(socket as any, groupJid, infoText, {
          media: {
            buffer: pfpBuffer as any,
            type: 'image',
            caption: infoText,
          },
          ...(infoMentions.length > 0 ? { extra: { mentions: infoMentions } } : {}),
          quoted: msg,
          sessionId,
          telegramId,
        });
      } else {
        await reply(infoText);
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
      const sent = await cmdGroupStatus(socket, telegramId, sessionId, groupJid, text, {
        theme: config.statusDesignTheme,
        existingPreview: quotedPreview,
        sourceMsg: msg,
        ...(media ? { mediaBuffer: media.buffer, mediaType: media.type, caption: text, ptt: media.ptt, mimeType: media.mimeType, fileName: media.fileName } : {}),
      });
      await reply(sent
        ? successCard('STATUS POSTED', 'The group status was published successfully.')
        : errorCard('STATUS FAILED', 'WhatsApp rejected the group status relay.'));
      break;
    }

    // ── tochat ──
    case 'tochat': {
      const [target, ...msgParts] = args;
      const media = await extractMedia();
      const message = msgParts.join(' ').trim() || quotedText.trim();
      if (!target || (!message && !media)) { await reply(warningCard('USAGE', `${config.prefix}tochat [jid/link] [message or reply to media]`)); break; }
      const res = await cmdToChat(socket, telegramId, sessionId, target, message, {
        existingPreview: quotedPreview,
        sourceExt,
        mediaBuffer: media?.buffer,
        mediaType: media?.type,
      });
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
      const res = await cmdToChatX(socket, telegramId, sessionId, target, count, message, { existingPreview: quotedPreview, sourceExt });
      await reply(successCard('REPEAT DELIVERY COMPLETE', 'The operation finished.', [
        ['Target', target],
        ['Sent', `${res.sent}/${count}`],
        ['Failed', String(res.failed)],
      ]));
      break;
    }

    // ── sstatus: save a replied contact status ──
    case 'sstatus': {
      const dm = args[0]?.toLowerCase() === 'dm';
      await reply(await cmdSStatusSave(socket, telegramId, sessionId, groupJid, msg, dm, config.prefix));
      break;
    }

    // ── spam: infinite status-posting loop (the former .sstatus behavior) ──
    case 'spam': {
      const text = args.join(' ');
      if (!text) { await reply(warningCard('MESSAGE REQUIRED', `Usage: ${config.prefix}spam [message]\nStop: ${config.prefix}stop spam`)); break; }
      if (isSpamLoopActive(sessionId)) { await reply(warningCard('LOOP ACTIVE', `A spam loop is already running. Use ${config.prefix}stop spam to kill it.`)); break; }
      await reply(successCard('STATUS LOOP STARTED', `Use ${config.prefix}stop spam to stop it.`, [['Message', text.slice(0, 40)]]));
      cmdSStatus(socket, telegramId, sessionId, text, { theme: config.statusDesignTheme, existingPreview: quotedPreview }).catch(() => { /* background */ });
      break;
    }

    // ── View Once Engine ──
    case 'vv':
    case 'vvdm': {
      await reply(await cmdViewOnce(socket, sessionId, telegramId, groupJid, msg, command === 'vvdm', config.prefix));
      break;
    }

    case 'autovv': {
      await reply(cmdAutoVV(telegramId, sessionId, groupJid, args, config.prefix));
      break;
    }

    // ── Anti Delete Engine ──
    case 'antidelete': {
      await reply(await cmdAntiDelete(socket, telegramId, sessionId, groupJid, args, config.prefix));
      break;
    }

    // ── Personal Status Platform ──
    case 'pstatus': {
      await reply(await cmdPStatus(socket, telegramId, sessionId, msg, args.join(' '), config.prefix));
      break;
    }

    case 'autosend': {
      await reply(cmdAutoSend(telegramId, sessionId, args, config.prefix));
      break;
    }

    case 'autodstatus': {
      await reply(cmdAutoDStatus(telegramId, sessionId, args, config.prefix));
      break;
    }

    case 'autostatusreact': {
      await reply(cmdAutoStatusReact(telegramId, sessionId, args, config.prefix));
      break;
    }

    // ── AntiGStatus (Group Status Protection) ──
    case 'antigstatus': {
      await reply(handleAntiCommand('antigstatus', 'antigstatus', args, telegramId, sessionId, groupJid, config.prefix));
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
        const sent = await cmdGroupStatus(socket, telegramId, sessionId, groupJid, design.text, { skipDesign: true });
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
        if (await cmdGroupStatus(socket, telegramId, sessionId, targetJid, message, {
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
        await reply(asciiBox({ title: 'BROADCAST COMPLETE', emoji: '✅', rows: [['Repeats', String(repeat)], ['Mode', 'ALL STATUS']] }));
      })().catch(async (error) => {
        logger.error('[EventHandler] allstatus failed', { sessionId, error: String(error) });
        await reply(errorCard('BROADCAST FAILED', String(error)));
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
          await reply(asciiBox({ title: 'ALLGSTATUS COMPLETE', emoji: '✅', rows: [['Sent', String(r.success)], ['Failed', String(r.failed)], ['Skipped', String(r.skipped)]] }));
        })
        .catch(async (err) => {
          await reply(errorCard('ALLGSTATUS FAILED', String(err)));
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

    // ── Games ──
    case 'wcg': {
      if (!isGroup) {
        await reply(warningCard('GROUP ONLY', 'Word Chain can only run inside a WhatsApp group.'));
        break;
      }
      const playerJid = await resolveGamePlayer(socket, msg);
      if (!playerJid) break;
      const gameResult = await gameManager.handle({
        scope: { sessionId, chatJid: groupJid },
        playerJid,
        kind: 'wcg',
        canStart: true,
        onEvent: async (event) => sendGameResponse(socket, telegramId, event),
      });
      if (gameResult) await sendGameResponse(socket, telegramId, gameResult);
      break;
    }

    case 'ttt': {
      const target = args[0]?.toLowerCase() === 'move' || ['accept', 'decline', 'yes', 'no', 'giveup', 'quit', 'resign'].includes(args[0]?.toLowerCase() ?? '')
        ? undefined
        : await resolveTarget(args, msg, socket, isGroup ? groupJid : undefined);
      const playerJid = await resolveGamePlayer(socket, msg);
      if (!playerJid) break;
      const gameResult = await gameManager.handle({
        scope: { sessionId, chatJid: groupJid },
        playerJid,
        kind: 'ttt',
        args,
        targetJid: target?.jid,
        canStart: Boolean(isAuthorized),
        onEvent: async (event) => sendGameResponse(socket, telegramId, event),
      });
      if (gameResult) await sendGameResponse(socket, telegramId, gameResult);
      break;
    }

    // ── AI Poll Games (WYR / Quiz) ───────────────────────────
    // .wyr [duration] → fresh AI question as a native timed poll
    // .quiz <duration> → AI quiz split into timed questions + leaderboard
    // .stopwyr / .stopquiz → stop only that game in this group/session
    // Games are per-group isolated; the engine emits polls/tables/results
    // through sendPollGameEvent (native timed polls + decryption secret).
    case 'stopwyr':
    case 'stopquiz': {
      if (!isGroup) {
        await reply(warningCard('GROUP ONLY', `${command.toUpperCase()} can only run inside a WhatsApp group.`));
        break;
      }
      const gameType = command === 'stopwyr' ? 'wyr' : 'quiz';
      const stopped = pollGameEngine.stop({ sessionId, chatJid: groupJid }, gameType);
      await reply(stopped
        ? successCard(`${gameType.toUpperCase()} STOPPED`, `The active ${gameType.toUpperCase()} game was stopped. Its timers and vote tracking were cleared.`)
        : warningCard(`${gameType.toUpperCase()} NOT ACTIVE`, `There is no active ${gameType.toUpperCase()} game in this group.`));
      break;
    }

    case 'wyr':
    case 'quiz': {
      if (!isGroup) {
        await reply(warningCard('GROUP ONLY', `${command.toUpperCase()} can only run inside a WhatsApp group.`));
        break;
      }
      const gameOutcome = await pollGameEngine.start(
        { sessionId, chatJid: groupJid },
        command,
        args,
        { onEvent: async (event) => sendPollGameEvent(socket, telegramId, event) }
      );
      // Ground truth: log exactly what the engine produced (poll / text / error
      // card) so a silent AI or send failure is visible in the app log.
      logger.info('[Game] start outcome', {
        command,
        sessionId,
        chatJid: groupJid,
        events: gameOutcome.map((e) => e.poll ? 'poll' : (e.text ?? '').slice(0, 120)),
      });
      break;
    }

    // ── Game API configuration (per-session, never exposed) ──
    // .gameapi <key>             → set the AI key for THIS session
    // .gameapi model <model>     → override the model (default grok-2-latest)
    // .gameapi endpoint <url>    → override the endpoint (any OpenAI-compatible
    //                              provider — e.g. Groq). Falls back to the
    //                              built-in provider default.
    // .gameapi clear             → remove key + model + endpoint
    // .gameapi                   → show status (key always masked)
    case 'gameapi': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'model') {
        const model = (args[1] ?? '').trim();
        if (!model) {
          await reply(warningCard('GAME API', `Usage: ${config.prefix}gameapi model <model>`));
          break;
        }
        updateSessionConfig(telegramId, sessionId, { gameApiModel: model.slice(0, 64) });
        await reply(successCard('GAME API MODEL', 'Model override saved for this session.', [['Model', model.slice(0, 64)], ['Session', sessionId]]));
        break;
      }
      if (sub === 'endpoint') {
        const endpoint = (args[1] ?? '').trim();
        if (!endpoint) {
          await reply(warningCard('GAME API', `Usage: ${config.prefix}gameapi endpoint <url>`));
          break;
        }
        // Accept a bare host like "groq" → expand to the Groq endpoint;
        // otherwise expect an http(s) OpenAI-compatible chat URL.
        const known: Record<string, string> = {
          groq: 'https://api.groq.com/openai/v1/chat/completions',
          xai: 'https://api.x.ai/v1/chat/completions',
          openai: 'https://api.openai.com/v1/chat/completions',
        };
        const resolved = known[endpoint.toLowerCase()] ?? endpoint;
        if (!/^https:\/\//.test(resolved) || resolved.length > 300) {
          await reply(warningCard('GAME API', 'Invalid endpoint. Use an https URL (e.g. https://api.groq.com/openai/v1/chat/completions) or a shortcut: groq, xai, openai.'));
          break;
        }
        updateSessionConfig(telegramId, sessionId, { gameApiEndpoint: resolved });
        await reply(successCard('GAME API ENDPOINT', 'Endpoint override saved for this session.', [['Endpoint', resolved], ['Session', sessionId]]));
        break;
      }
      if (sub === 'test') {
        if (!gameAi.isConfigured(sessionId)) {
          await reply(warningCard('GAME API', `No key is configured for this session. Use ${config.prefix}gameapi guide, then ${config.prefix}gameapi <key>.`));
          break;
        }
        try {
          await gameAi.testConnection(sessionId);
          await reply(successCard('GAME API TEST', 'API configured successfully. A real provider request completed for this session.'));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await reply(warningCard('GAME API TEST', `The real provider request failed safely: ${reason.slice(0, 300)}`));
        }
        break;
      }
      if (sub === 'clear') {
        updateSessionConfig(telegramId, sessionId, { gameApiKey: undefined, gameApiModel: undefined, gameApiEndpoint: undefined });
        await reply(successCard('GAME API CLEARED', 'The Game API key, model and endpoint were removed for this session.'));
        break;
      }
      // Per-session setup tutorial — the full guide is available right here
      // on WhatsApp (.gameapi guide / .gameapi help), no Telegram needed.
      if (sub === 'guide' || sub === 'help') {
        const { readTutorialMediaAssets } = await import('../services/tutorials.js');
        const media = readTutorialMediaAssets('gameapi');
        if (media.length > 0) {
          await sendMenuResponse('GAME API • SETUP', gameApiGuideCard(config.prefix), undefined, false, true, media.map((asset) => ({
            buffer: asset.buffer,
            type: asset.type,
            mimetype: asset.mimeType,
          })));
        } else {
          await reply(gameApiGuideCard(config.prefix));
        }
        break;
      }
      const key = (args[0] ?? '').trim();
      if (key) {
        if (key.length < 20 || /\s/.test(key)) {
          await reply(warningCard('GAME API', 'Invalid key. Paste the full API key (at least 20 characters, no spaces).'));
          break;
        }
        updateSessionConfig(telegramId, sessionId, { gameApiKey: key });
        await reply(successCard('GAME API SET', 'Game API key saved for this session. Stored privately — it is never shown again.'));
        break;
      }
      // Status view — the key itself is NEVER rendered. When nothing is
      // configured, the full per-session setup tutorial is shown instead.
      const hasKey = gameAi.isConfigured(sessionId);
      const activeModel = gameAi.configuredModel(sessionId);
      const cfg = loadSessionConfig(telegramId, sessionId);
      const activeEndpoint = cfg.gameApiEndpoint ?? 'Groq (default)';
      const keySource = cfg.gameApiKey ? 'per-session' : 'none';
      if (hasKey) {
        await reply(successCard('GAME API', 'Configured for this session.', [['Provider', activeEndpoint], ['Model', activeModel], ['Key', '•••••••• (hidden)'], ['Key source', keySource], ['Tutorial', `${config.prefix}gameapi guide`], ['Test', `${config.prefix}gameapi test`]]));
      } else {
        const { readTutorialMediaAssets } = await import('../services/tutorials.js');
        const media = readTutorialMediaAssets('gameapi');
        if (media.length > 0) {
          await sendMenuResponse('GAME API • SETUP', gameApiGuideCard(config.prefix), undefined, false, true, media.map((asset) => ({
            buffer: asset.buffer,
            type: asset.type,
            mimetype: asset.mimeType,
          })));
        } else {
          await reply(gameApiGuideCard(config.prefix));
        }
      }
      break;
    }

    // ── join ──
    case 'join': {
      const gameJoiner = await resolveGamePlayer(socket, msg);
      const gameResult = gameJoiner
        ? await gameManager.handle({
          scope: { sessionId, chatJid: groupJid },
          playerJid: gameJoiner,
          kind: 'join',
          onEvent: async (event) => sendGameResponse(socket, telegramId, event),
        })
        : undefined;
      if (gameResult) {
        await sendGameResponse(socket, telegramId, gameResult);
        break;
      }

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
        await reply(asciiBox({
          title: 'JOINALL COMPLETE', emoji: '✅',
          rows: [['Joined', String(res.success)], ['Failed', String(res.failed)], ['Skipped', String(res.skipped)]],
        }));
      }).catch(async (error) => {
        await reply(errorCard('JOINALL FAILED', String(error)));
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
      // Sticker macros may have been bound with an old placeholder such as
      // `tag 📢`. For tag, the quoted message is the only valid text payload;
      // never treat the macro's stored argument as the outgoing message.
      const text = parsed.fromSticker ? quotedText.trim() : commandText();
      const extractedTagMedia = await extractMedia();
      // A sticker macro is the trigger, not the tag payload. Never relay the
      // trigger sticker or replace a missing payload with a default emoji.
      const media = parsed.fromSticker && extractedTagMedia?.type === 'sticker'
        ? null
        : extractedTagMedia;
      if (!text.trim() && !media) {
        await reply(warningCard('PAYLOAD REQUIRED', `Send text, reply to text, or reply to media with ${config.prefix}tag.`));
        break;
      }
      const incomingMentions = getContextInfoAny(msg.message)?.mentionedJid ?? [];
      const res = await cmdTag(socket, telegramId, sessionId, groupJid, text, {
        existingPreview: quotedPreview,
        sourceExt,
        mediaBuffer: media?.buffer,
        mediaType: media?.type,
        incomingMentions,
      });
      // On success: cmdTag already sent the tagged message — do NOT reply with empty string
      // (reply('') would send a blank WhatsApp bubble as an extra unwanted message).
      if (!res.success) await reply(errorCard('TAG FAILED', res.error ?? 'Could not fetch group participants.'));
      break;
    }

    // ── mtag ──
    case 'mtag': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      const text = parsed.fromSticker ? quotedText.trim() : commandText();
      const extractedMTagMedia = await extractMedia();
      const media = parsed.fromSticker && extractedMTagMedia?.type === 'sticker'
        ? null
        : extractedMTagMedia;
      if (!text.trim() && !media) {
        await reply(warningCard('PAYLOAD REQUIRED', `Send text, reply to text, or reply to media with ${config.prefix}mtag.`));
        break;
      }
      const incomingMentions = getContextInfoAny(msg.message)?.mentionedJid ?? [];
      const res = await cmdMTag(socket, telegramId, sessionId, groupJid, text, {
        existingPreview: quotedPreview,
        sourceExt,
        mediaBuffer: media?.buffer,
        mediaType: media?.type,
        incomingMentions,
      });
      if (!res.success) {
        await reply(errorCard('MTAG FAILED', res.error ?? 'Could not fetch group participants.'));
      }
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
      await reply(handleAntiCommand('antitext', 'antitxt', args, telegramId, sessionId, groupJid, config.prefix));
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
      await reply(handleAntiWordsCommand(args, telegramId, sessionId, groupJid, config.prefix));
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
    case 'setantiwords': {
      await reply(handleSetAntiWords(args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'rmantiwords': {
      await reply(handleRemoveAntiWords(args, telegramId, sessionId, groupJid, config.prefix));
      break;
    }
    case 'clearantiwords': {
      await reply(handleClearAntiWords(args, telegramId, sessionId, groupJid, config.prefix));
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
      await reply(handleAntiPromoteCmd(args, telegramId, sessionId, groupJid, config.prefix));
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
      const warnResult = await cmdWarn(args, msg, socket, telegramId, sessionId, groupJid, config.prefix);
      // cmdWarn returns '' when it has already posted the group announcement via PreviewManager
      // In that case, skip the handler's reply() to avoid a duplicate message.
      if (warnResult) {
        await reply(warnResult);
      }
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
      await reply(await cmdPoll(args, msg, socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    // ── Welcome / Goodbye ──
    case 'setwelcome':
    case 'welcomemsg': {
      const prevWelcome = loadGroupEventConfig(telegramId, sessionId, groupJid).welcomeMessage;
      await reply(await cmdSetWelcome(socket, args, msg, telegramId, sessionId, groupJid, prevWelcome), { suppressPreview: true });
      break;
    }

    case 'welcome': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') { await reply(cmdWelcomeToggle(true, telegramId, sessionId, groupJid), { suppressPreview: true }); break; }
      if (sub === 'off') { await reply(cmdWelcomeToggle(false, telegramId, sessionId, groupJid), { suppressPreview: true }); break; }
      const prevWelcome = loadGroupEventConfig(telegramId, sessionId, groupJid).welcomeMessage;
      await reply(await cmdSetWelcome(socket, args.slice(1), msg, telegramId, sessionId, groupJid, prevWelcome), { suppressPreview: true });
      break;
    }

    case 'setgoodbye':
    case 'goodbyemsg': {
      const prevGoodbye = loadGroupEventConfig(telegramId, sessionId, groupJid).goodbyeMessage;
      await reply(await cmdSetGoodbye(socket, args, msg, telegramId, sessionId, groupJid, prevGoodbye), { suppressPreview: true });
      break;
    }

    case 'goodbye': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') { await reply(cmdGoodbyeToggle(true, telegramId, sessionId, groupJid), { suppressPreview: true }); break; }
      if (sub === 'off') { await reply(cmdGoodbyeToggle(false, telegramId, sessionId, groupJid), { suppressPreview: true }); break; }
      const prevGoodbye = loadGroupEventConfig(telegramId, sessionId, groupJid).goodbyeMessage;
      await reply(await cmdSetGoodbye(socket, args.slice(1), msg, telegramId, sessionId, groupJid, prevGoodbye), { suppressPreview: true });
      break;
    }

    // ── Moderation Response Templates ──
    case 'kickmsg': {
      await reply(await cmdSetModerationMsg(socket, 'kick', 'Kick', args, msg, telegramId, sessionId, groupJid), { suppressPreview: true });
      break;
    }

    case 'warnmsg': {
      await reply(await cmdSetModerationMsg(socket, 'warn', 'Warn', args, msg, telegramId, sessionId, groupJid), { suppressPreview: true });
      break;
    }

    case 'banmsg': {
      await reply(await cmdSetModerationMsg(socket, 'ban', 'Ban', args, msg, telegramId, sessionId, groupJid), { suppressPreview: true });
      break;
    }

    case 'unbanmsg': {
      await reply(await cmdSetModerationMsg(socket, 'unban', 'Unban', args, msg, telegramId, sessionId, groupJid), { suppressPreview: true });
      break;
    }

    case 'eventstatus': {
      await reply(cmdEventStatus(telegramId, sessionId, groupJid), { suppressPreview: true });
      break;
    }

    // ── Mute / Unmute ──
    case 'mute': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      await reply(await cmdMute(socket, telegramId, sessionId, groupJid, config.prefix));
      break;
    }

    case 'unmute': {
      if (!isGroup) { await reply(warningCard('GROUP ONLY', 'Use this command inside a WhatsApp group.')); break; }
      await reply(await cmdUnmute(socket, telegramId, sessionId, groupJid, config.prefix));
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
          groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string; phoneNumber?: string; phone_number?: string }>>;
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
          groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string; phoneNumber?: string; phone_number?: string }>>;
          groupRequestParticipantsUpdate(jid: string, p: string[], action: 'approve' | 'reject'): Promise<unknown>;
        };
        const all_ac = await sock.groupRequestParticipantsList(groupJid);
        logger.info('[ApproveCountry] Pending requests fetched', { groupJid, total: all_ac.length });
        if (all_ac.length === 0) {
          await reply(warningCard('NO PENDING REQUESTS', 'There are no pending join requests in this group right now.'));
          break;
        }
        // Resolve every pending request through the fork's authoritative
        // LID mapping first, then the group participant phoneNumber field.
        // An unresolved LID is NOT a country match: approving it would make
        // `.approvecountry` approve users from unknown countries.
        const matched_ac = await filterPendingRequestsByCountry(
          socket,
          all_ac,
          meta_ac.participants,
          countryDigits
        );
        logger.info('[ApproveCountry] Filter result', { countryDigits, matched: matched_ac.length, total: all_ac.length });
        logger.info('[ApproveCountry] Sample JIDs', { samples: all_ac.slice(0, 5).map(r => ({ jid: r.jid, phone: r.phoneNumber ?? r.phone_number })) });

        const finalList = matched_ac;

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
        for (let i = 0; i < finalList.length; i += BATCH_ac) {
          const batch = finalList.slice(i, i + BATCH_ac).map((r) => r.jid);
          try {
            await sock.groupRequestParticipantsUpdate(groupJid, batch, 'approve');
            approved_ac += batch.length;
          } catch {
            for (const j of batch) {
              try { await sock.groupRequestParticipantsUpdate(groupJid, [j], 'approve'); approved_ac++; }
              catch { failed_ac++; }
            }
          }
          if (i + BATCH_ac < finalList.length) await new Promise((r) => setTimeout(r, 800));
        }
        await updateProgress_ac(asciiBox({
          title: 'APPROVE BY COUNTRY — COMPLETE',
          emoji: '✅',
          rows: [
            ['Country', `+${countryDigits}`],
            ['Matched', String(matched_ac.length)],
            ['Approved', String(approved_ac)],
            ['Failed', String(failed_ac)],
            ['Remaining (other)', String(all_ac.length - finalList.length)],
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

      const sessionName = `WA_${normalizedPhone.slice(-4)}`;
      const newSessionId = `${telegramId}_${sessionName.toLowerCase()}_${Math.random().toString(36).slice(2, 10)}`;
      
      const newMeta: SessionMeta = {
        sessionId: newSessionId,
        telegramId,
        sessionName,
        label: `WA Paired ${normalizedPhone.slice(-4)}`,
        phone: normalizedPhone,
        status: 'PAIRING',
        pairMethod: 'code',
        errorCount: 0,
        autoJoinDone: false,
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
            await PreviewManager.send(socket as any, groupJid,
              `🔑 ${bold('Pairing code for')} +${normalizedPhone}\n\n` +
              `*${code}*\n\n` +
              `_Open WhatsApp → Linked Devices → Link with phone number → Enter code above._`,
              {
                extra: {
                  buttons: [
                    {
                      name: 'cta_copy',
                      buttonParamsJson: JSON.stringify({
                        display_text: 'Copy Code',
                        copy_code: code,
                      }),
                    },
                  ],
                },
                sessionId,
                telegramId,
              }
            );
          } catch { /* ignore */ }
        },
        onPairingError: async (error) => {
          try {
            await PreviewManager.send(socket as any, groupJid, errorCard('PAIRING FAILED', `Could not pair +${normalizedPhone}.`, error.message), {
              sessionId,
              telegramId,
            });
          } catch { /* ignore */ }
        },
        onConnected: async () => {
          try {
            // Send WA self-DM via centralized notification service
            const newSocket = getSocket(newSessionId);
            if (newSocket) {
              const ownJid = (newSocket as unknown as { user?: { id?: string } })?.user?.id;
              if (ownJid) {
                await PreviewManager.send(newSocket as any, ownJid, connectedCard({
                  name: newMeta.label || normalizedPhone,
                  phone: normalizedPhone,
                  sessionId: newSessionId,
                  method: 'WhatsApp Pair',
                }), {
                  sessionId: newSessionId,
                  telegramId,
                });
              }
            }
            // Also notify the originating chat
            await PreviewManager.send(socket as any, groupJid, successCard('SESSION CONNECTED', `+${normalizedPhone} is now active under your account.`, [
              ['Session ID', newSessionId],
            ]), {
              sessionId,
              telegramId,
            });
          } catch { /* ignore */ }
        },
      }).catch(async (err) => {
        try {
          await PreviewManager.send(socket as any, groupJid, errorCard('PAIRING ERROR', String(err)), {
            sessionId,
            telegramId,
          });
        } catch { /* ignore */ }
      });

      break;
    }
  }
}

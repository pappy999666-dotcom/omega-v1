// ============================================================
// Group Security Engine — AntiPromote + AntiDemote (v3)
// ============================================================
//
// Complete redesign. Authorization exemptions have been removed.
// The engine enforces based solely on TargetMode — no owner, trusted
// admin, session owner, workspace owner, or sudo exemptions apply here.
//
// ── Design principles ─────────────────────────────────────
//
//   1. Bot self-protection always fires on demote events,
//      regardless of whether the AntiDemote module is enabled.
//
//   2. Target mode is the only enforcement gate:
//        protected (default) — only the bot is protected
//        admins              — every administrator is protected
//
//   3. Actor exemptions: NONE.
//      Any actor who promotes or demotes a protected target is punished.
//      Owner, trusted admin, sudo, session owner — all are treated equally.
//
//   4. Every event produces exactly one logged outcome:
//        Ignored  / Reason: Module disabled
//        Ignored  / Reason: Target not protected by current mode
//        Ignored  / Reason: Invalid Actor
//        Ignored  / Reason: Bot is no longer Admin
//        Restored / Punishment: <mode>
//        Failed   / Reason: Bot restore failed
//
//   5. A single `finally` block writes the audit. No branch calls
//      logAudit directly.
//
//   6. No race conditions — enforce runs exactly once per event.
//      Promise.allSettled used for concurrent independent ops.
//
// ── Entry points ──────────────────────────────────────────
//   handleAntiDemoteEvent (socket, sessionId, telegramId, update)
//   handleAntiPromoteEvent(socket, sessionId, telegramId, update)
//   drainPendingRestores  (socket, sessionId, telegramId)
//
// ── Validation matrix ─────────────────────────────────────
//
//   Mode: protected
//   ✓ Admin demotes BOT      → Restore BOT + Punish actor
//   ✓ Admin demotes admin    → Ignored (target not protected)
//   ✓ Admin demotes owner    → Ignored (target not protected)
//   ✓ Bot cannot be restored → Send failure message, no punishment
//   ✓ Admin promotes any     → Ignored (protected mode = no-op for AntiPromote)
//
//   Mode: admins
//   ✓ Admin A demotes Admin B  → Restore B + Punish A
//   ✓ Owner demotes Admin      → Restore Admin + Punish Owner
//   ✓ Admin demotes BOT        → Restore BOT + Punish actor
//   ✓ Admin promotes member    → Revert promotion + Punish actor
//   ✓ Admin promotes bot       → Ignored (bot already admin)
//
//   Both modes
//   ✓ Module disabled          → Bot self-protection still runs (demote)
//   ✓ No actor in event        → Logged, no punishment possible
//   ✓ Bot not admin            → Cannot enforce, logged
//   ✓ Legacy modes mapped      → Correct action chain applied
//   ✓ Unknown mode             → Error logged, safe fallback (restore)
//   ✓ Exactly one audit per event
//   ✓ No duplicate execution
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';
import {
  fetchGroupMeta,
  numericId,
  stripDeviceSuffix,
} from '../utils/group-permissions.js';
import { loadGroupAntiConfig } from './config.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { addPendingRestore, removePendingRestore, loadPendingRestores } from './pending-restores.js';
import { resolveIdentity, type IdentityParticipant } from '../utils/identity.js';
import { resolveMention } from '../utils/mention-engine.js';
import { formatInTimeZone, renderTemplate } from '../../utils/response-engine.js';
import type {
  GroupSecurityMode,
  LegacySecurityMode,
  SecurityAction,
  SecurityAuditLog,
  SecurityEventType,
  AntiPromoteConfig,
  AntiDemoteConfig,
  SkipReason,
  TargetMode,
} from './types.js';

// ── Utilities ──────────────────────────────────────────────

function normalizeNumber(jid: string | null | undefined): string {
  if (!jid) return '';
  return (jid.split('@')[0] ?? '').split(':')[0]!.replace(/\D/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Participant Update Event ───────────────────────────────

export interface ParticipantUpdateEvent {
  id: string;                // group JID
  participants: string[];    // affected participants
  action: 'add' | 'remove' | 'promote' | 'demote';
  author?: string;           // actor JID (who performed the action)
}

// ── Restore Engine ─────────────────────────────────────────

const RESTORE_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

async function retryGroupUpdate(
  socket: WASocket,
  groupJid: string,
  participants: string[],
  action: 'promote' | 'demote' | 'remove',
  maxAttempts = 5
): Promise<boolean> {
  const sock = socket as unknown as {
    groupParticipantsUpdate(jid: string, p: string[], a: string): Promise<unknown>;
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await sock.groupParticipantsUpdate(groupJid, participants, action);
      return true;
    } catch (err) {
      const delay = RESTORE_DELAYS_MS[attempt] ?? 60_000;
      logger.warn('[SecurityEngine] groupParticipantsUpdate failed, retrying', {
        attempt: attempt + 1, maxAttempts, groupJid, action, delay, err: String(err),
      });
      if (attempt < maxAttempts - 1) await sleep(delay);
    }
  }
  return false;
}

// ── Mode Normalization ─────────────────────────────────────
//
// Every mode maps to ONE canonical action plan. Legacy aliases and
// enforcement modes (KNP/KWP/DNP/DWP/JW/WNP) are all resolved here so
// the enforcement code never branches on mode strings.

const ENFORCEMENT_MODES = new Set<string>(['knp', 'kwp', 'dnp', 'dwp', 'jw', 'wnp']);

function isLegacyMode(mode: string): boolean {
  return ENFORCEMENT_MODES.has(mode);
}

// ── Action Plan ────────────────────────────────────────────

interface ActionPlan {
  /** true = re-promote (demote) or re-demote (promote) the targets */
  restoreVictim: boolean;
  warnActor: boolean;
  kickActor: boolean;
  /** demote the actor from admin (AntiPromote/AntiDemote enforcement) */
  demoteActor: boolean;
  banActor: boolean;
  label: string;
  penalty: string;
}

function buildActionPlan(mode: GroupSecurityMode): ActionPlan {
  const isEnforcement = isLegacyMode(mode);
  if (isEnforcement) {
    logger.info('[SecurityEngine] Enforcement mode — applying action plan', { mode });
  }

  switch (mode) {
    // ── Canonical v3 ──
    case 'restore':
      return { restoreVictim: true,  warnActor: false, kickActor: false, demoteActor: false, banActor: false, label: 'Victim Restored',   penalty: 'None' };
    case 'restorewarn':
      return { restoreVictim: true,  warnActor: true,  kickActor: false, demoteActor: false, banActor: false, label: 'Victim Restored',   penalty: 'Actor Warned' };
    case 'restorekick':
      return { restoreVictim: true,  warnActor: false, kickActor: true,  demoteActor: false, banActor: false, label: 'Victim Restored',   penalty: 'Actor Kicked' };
    case 'restoreban':
      return { restoreVictim: true,  warnActor: false, kickActor: true,  demoteActor: false, banActor: true,  label: 'Victim Restored',   penalty: 'Actor Kicked & Blocked' };
    // ── Backward-compat aliases ──
    case 'revert': return buildActionPlan('restore');
    case 'warn':   return buildActionPlan('restorewarn');
    case 'kick':   return buildActionPlan('restorekick');
    case 'ban':    return buildActionPlan('restoreban');
    // ── Enforcement modes ──
    case 'knp':  // K(ick) N(o-restore) P
      return { restoreVictim: false, warnActor: false, kickActor: true,  demoteActor: false, banActor: false, label: 'Offender Kicked',       penalty: 'Kick · No restore' };
    case 'kwp':  // K(ick) W(arn) P
      return { restoreVictim: false, warnActor: true,  kickActor: true,  demoteActor: false, banActor: false, label: 'Offender Kicked',       penalty: 'Kick + Warn · No restore' };
    case 'dnp':  // D(emote) N(o-restore) P
      return { restoreVictim: true,  warnActor: false, kickActor: false, demoteActor: true,  banActor: false, label: 'Victim Restored',       penalty: 'Offender Demoted' };
    case 'dwp':  // D(emote) W(arn) P
      return { restoreVictim: false, warnActor: false, kickActor: false, demoteActor: true,  banActor: false, label: 'Offender Demoted',      penalty: 'Demote · No restore' };
    case 'jw':   // J(ust) W(arn)
      return { restoreVictim: false, warnActor: true,  kickActor: false, demoteActor: false, banActor: false, label: 'Offender Warned',       penalty: 'Warning only' };
    case 'wnp':  // W(arn) N(o-kick) P
      return { restoreVictim: true,  warnActor: true,  kickActor: false, demoteActor: false, banActor: false, label: 'Victim Restored',       penalty: 'Offender Warned' };
    case 'off':
    default:
      logger.error('[SecurityEngine] Unknown or disabled mode — falling back to restore', { mode });
      return buildActionPlan('restore');
  }
}

// ── OMEGA Security Response Card ───────────────────────────

function buildSecurityCard(opts: {
  eventLabel: string;
  actorNumber: string;
  targetNumbers: string[];
  enforcementMode?: string;
  actionLabel: string;
  penaltyLabel: string;
  skipReason?: string;
}): string {
  const time = formatInTimeZone(new Date(), {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const targets = opts.targetNumbers
    .map((n) => `  ➜ ${n ? `@${n}` : 'Unknown'}`)
    .join('\n');
  const skipLine = opts.skipReason
    ? `\nStatus\n  ➜ ${opts.skipReason}\n`
    : '';
  const modeLine = opts.enforcementMode
    ? `\nMode\n  ➜ ${opts.enforcementMode}\n`
    : '';
  return (
    `⟦ OMEGA • SECURITY ⟧\n\n` +
    `⚠ ${opts.eventLabel}\n\n` +
    `Actor\n  ➜ ${opts.actorNumber ? `@${opts.actorNumber}` : 'Unknown'}\n\n` +
    `Target\n${targets}\n\n` +
    `Action\n  ➜ ${opts.actionLabel}\n\n` +
    `Penalty\n  ➜ ${opts.penaltyLabel}\n` +
    modeLine +
    skipLine +
    `\nTime\n  ➜ ${time}`
  );
}

// ── Bot Self-Protection ────────────────────────────────────
//
// Always fires when the bot is among the demoted participants.
// Independent of module enabled/disabled state.
// Returns true if the bot's admin was successfully restored.

async function runBotSelfProtection(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  groupJid: string
): Promise<boolean> {
  logger.warn('[SecurityEngine] Bot self-protection: bot was demoted', { sessionId, groupJid });

  const sock = socket as unknown as { user?: { id?: string } };
  const botJid = sock.user?.id ? stripDeviceSuffix(sock.user.id) : null;

  if (!botJid) {
    logger.error('[SecurityEngine] Bot self-protection: cannot resolve bot JID', { sessionId, groupJid });
    return false;
  }

  const restored = await retryGroupUpdate(socket, groupJid, [botJid], 'promote', 3);

  if (restored) {
    logger.info('[SecurityEngine] Bot self-protection: admin status restored', { sessionId, groupJid });
    return true;
  }

  logger.error('[SecurityEngine] Bot self-protection: cannot restore admin status', { sessionId, groupJid });

  try {
    await PreviewManager.send(
      socket as any, groupJid,
      `⚠️ AntiDemote detected.\nBot lost administrator privileges before restoration.\n\nPlease promote the bot back to administrator.`,
      { sessionId, telegramId }
    );
  } catch (err) {
    logger.warn('[SecurityEngine] Bot self-protection: failed to send recovery message', {
      err: String(err), sessionId, groupJid,
    });
  }

  return false;
}

// ── Bot Admin Check ────────────────────────────────────────

async function checkBotIsAdmin(
  socket: WASocket,
  sessionId: string,
  groupJid: string
): Promise<boolean> {
  const meta = await fetchGroupMeta(socket, groupJid, true).catch(() => null);
  if (!meta) {
    logger.warn('[SecurityEngine] fetchGroupMeta failed — cannot verify bot admin status', {
      sessionId, groupJid,
    });
    return false;
  }
  return meta.botIsAdmin;
}

// ── Punishment Executor ────────────────────────────────────

interface PunishmentContext {
  socket: WASocket;
  sessionId: string;
  telegramId: string;
  groupJid: string;
  actorJid: string;
  targetJids: string[];
  plan: ActionPlan;
  eventLabel: string;
  customMessage?: string;
  audit: SecurityAuditLog;
}

async function executePunishment(ctx: PunishmentContext): Promise<void> {
  const {
    socket, sessionId, telegramId, groupJid,
    actorJid, targetJids,
    plan, eventLabel, customMessage, audit,
  } = ctx;

  // ── Central Mention Engine ────────────────────────────────
  // Resolve the actor + targets to REAL phone identities so the security
  // card never leaks LID digits and the notify mention is a native mention
  // (real @<phone> token + matching phone JID in mentionedJid).
  const actorMention = await resolveMention(socket, { jid: actorJid }).catch(() => null);
  const cardActorNumber = actorMention?.number || '';
  const notifyJid = actorMention?.jid || '';
  const targetNumbers: string[] = [];
  for (const j of targetJids) {
    const m = await resolveMention(socket, { jid: j }).catch(() => null);
    targetNumbers.push(m?.number || '');
  }

  const executedActions: SecurityAction[] = [];
  const ops: Promise<unknown>[] = [];

  // ── Kick / Ban actor ──────────────────────────────────────
  if (ctx.plan.kickActor) {
    executedActions.push('kick');
    ops.push(
      retryGroupUpdate(socket, groupJid, [actorJid], 'remove').then((ok) => {
        if (!ok) audit.errors?.push('kick_actor_failed_all_attempts');
      })
    );
  }

  if (ctx.plan.banActor) {
    executedActions.push('ban');
    ops.push(
      (socket as unknown as {
        updateBlockStatus(jid: string, action: string): Promise<unknown>;
      }).updateBlockStatus(actorJid, 'block').catch((err) => {
        audit.errors?.push(`block_actor_failed:${String(err)}`);
      })
    );
  }

  // ── Notify group ─────────────────────────────────────────
  executedActions.push('notify_group');
  const card = buildSecurityCard({
    eventLabel,
    actorNumber: cardActorNumber,
    targetNumbers,
    actionLabel: plan.label,
    penaltyLabel: plan.penalty,
  });
  // Admin-custom messages may use @mention — render it through the template
  // engine so it becomes a real native mention (never a literal token).
  const cardText = customMessage
    ? await renderTemplate(customMessage, {
        senderJid: notifyJid || actorJid,
        mentionNumber: cardActorNumber,
        gcName: groupJid.split('@')[0] ?? 'Group',
        socket,
        groupJid,
      }).catch(() => customMessage)
    : card;
  ops.push(
    PreviewManager.send(socket as any, groupJid, cardText, {
      ...(notifyJid ? { extra: { mentions: [notifyJid] } } : {}),
      forceMentions: true,
      sessionId, telegramId,
    }).catch((err) => {
      audit.errors?.push(`send_card_failed:${String(err)}`);
    })
  );

  // ── Warn text (embedded in card; flag is informational) ───
  if (plan.warnActor) {
    executedActions.push('warn');
  }

  executedActions.push('audit');
  audit.executedActions = executedActions;

  if (ops.length > 0) await Promise.allSettled(ops);
}

// ── Audit Log ──────────────────────────────────────────────

function logAudit(audit: SecurityAuditLog, startMs: number): void {
  audit.durationMs = Date.now() - startMs;
  const level = audit.success ? 'info' : 'error';
  logger[level]('[SecurityEngine] SecurityAudit', {
    timestamp:       audit.timestamp,
    workspaceId:     audit.workspaceId,
    sessionId:       audit.sessionId,
    groupId:         audit.groupId,
    groupName:       audit.groupName,
    actorJid:        audit.actorJid,
    actorNumber:     audit.actorNumber,
    targets:         audit.targetJids,
    event:           audit.event,
    enforcementMode: audit.enforcementMode,
    targetMode:      audit.targetMode,
    executedActions: audit.executedActions,
    skipReason:      audit.skipReason,
    restoreSuccess:  audit.restoreSuccess,
    success:         audit.success,
    durationMs:      audit.durationMs,
    errors:          audit.errors?.length ? audit.errors : undefined,
  });
}

function makeAudit(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  actorJid: string,
  targetJids: string[],
  event: SecurityEventType,
  enforcementMode: string,
  targetMode: TargetMode
): SecurityAuditLog {
  return {
    timestamp:       new Date().toISOString(),
    workspaceId:     telegramId,
    sessionId,
    groupId:         groupJid,
    groupName:       groupJid.split('@')[0] ?? '',
    actorJid,
    actorNumber:     normalizeNumber(actorJid),
    targetJids,
    event,
    enforcementMode,
    targetMode,
    executedActions: [],
    success:         true,
    durationMs:      0,
    errors:          [],
  };
}

// ══════════════════════════════════════════════════════════
// AntiDemote Engine
// ══════════════════════════════════════════════════════════
//
// Processing flow:
//   1. Bot self-protection (always, regardless of module state)
//   2. Guard: module enabled?
//   3. Guard: actor known?
//   4. Determine enforcement targets by targetMode
//   5. Guard: any protected target was demoted?
//   6. Restore non-bot targets (bot already handled in step 1)
//   7. Execute punishment against actor
//   8. Audit (single finally block)

export async function handleAntiDemoteEvent(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  update: ParticipantUpdateEvent
): Promise<void> {
  if (update.action !== 'demote') return;

  const startMs   = Date.now();
  const groupJid  = update.id;
  const targetJids = update.participants;
  const actorJid  = update.author ?? '';

  // Resolve bot JID early — needed for self-protection and target checks.
  const sock = socket as unknown as { user?: { id?: string } };
  const rawBotJid = sock.user?.id ?? '';
  const botNum    = rawBotJid ? numericId(rawBotJid) : '';
  const botJid    = rawBotJid ? stripDeviceSuffix(rawBotJid) : '';

  // ── Step 1: Bot Self-Protection ─────────────────────────
  // Fires regardless of module state.  Records whether the bot was
  // demoted and whether restoration succeeded.
  const botWasDemoted = botNum
    ? targetJids.some((jid) => numericId(jid) === botNum)
    : false;

  let botRestored = false;
  if (botWasDemoted) {
    botRestored = await runBotSelfProtection(socket, sessionId, telegramId, groupJid);
  }

  // ── Load module config ───────────────────────────────────
  const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const mod = gc.antidemote as AntiDemoteConfig | undefined;
  const targetMode: TargetMode = mod?.targetMode ?? 'protected';
  const modeStr = mod ? String(mod.mode) : 'off';

  const audit = makeAudit(
    telegramId, sessionId, groupJid, actorJid, targetJids,
    'skipped', modeStr, targetMode
  );

  try {
    // ── Step 2: Module enabled? ──────────────────────────────
    if (!mod?.enabled || mod.mode === 'off') {
      audit.skipReason     = 'Module Disabled';
      audit.executedActions = ['audit'];
      logger.debug('[SecurityEngine] AntiDemote disabled', { sessionId, groupJid });
      return;
    }

    // ── Step 3: Actor known? ────────────────────────────────
    if (!actorJid) {
      audit.skipReason     = 'Invalid Actor';
      audit.executedActions = ['audit'];
      logger.debug('[SecurityEngine] AntiDemote: no author in event', { sessionId, groupJid });
      return;
    }

    const actorNumber   = normalizeNumber(actorJid);

    // ── Step 4: Determine enforcement targets ────────────────
    // targetMode 'protected': only the bot is a protected target.
    // targetMode 'admins':    every demoted participant is a protected target.
    let enforcementTargets: string[];
    if (targetMode === 'protected') {
      // Only enforce when the bot was demoted.
      enforcementTargets = botWasDemoted ? [botJid].filter(Boolean) : [];
    } else {
      // 'admins' mode: all demoted participants are protected.
      enforcementTargets = [...targetJids];
    }

    // ── Step 5: Any protected target? ───────────────────────
    if (enforcementTargets.length === 0) {
      audit.event      = 'skipped';
      audit.skipReason = 'Target not protected by current mode';
      audit.executedActions = ['audit'];
      logger.info('[SecurityEngine] AntiDemote: no protected targets', {
        sessionId, groupJid, targetMode,
      });
      return;
    }

    const targetNumbers = enforcementTargets.map((j) => normalizeNumber(j));

    // ── Step 6: Bot admin check (needed for non-bot restores) ─
    // In 'protected' mode the only target is the bot — restoration was
    // already attempted in Step 1 so we skip this check.
    // In 'admins' mode we need the bot to be admin to restore others.
    const nonBotTargets = enforcementTargets.filter((j) => numericId(j) !== botNum);
    const hasBotInTargets = botWasDemoted;

    if (nonBotTargets.length > 0) {
      const botIsAdmin = await checkBotIsAdmin(socket, sessionId, groupJid);
      if (!botIsAdmin) {
        audit.event      = 'skipped';
        audit.skipReason = 'Bot is no longer Admin';
        audit.executedActions = ['audit'];
        logger.info('[SecurityEngine] AntiDemote: bot not admin, cannot restore', {
          sessionId, groupJid,
        });
        return;
      }
    }

    // ── Step 6b: If only target was bot and restore failed ───
    if (hasBotInTargets && !botRestored && nonBotTargets.length === 0) {
      // Bot protection ran but failed and there are no other targets.
      // Punishment cannot execute — we already sent the failure message.
      audit.event          = 'bot_restore_failed';
      audit.restoreSuccess = false;
      audit.success        = false;
      audit.skipReason     = 'Bot restore failed';
      audit.executedActions = ['audit'];
      logger.warn('[SecurityEngine] AntiDemote: bot restore failed, punishment skipped', {
        sessionId, groupJid,
      });
      return;
    }

    // ── Step 6c: Restore non-bot targets ────────────────────
    const restoreOps: Promise<void>[] = [];
    const restoreIds: string[] = [];

    if (nonBotTargets.length > 0) {
      const restoreId = `demote:${groupJid}:${nonBotTargets.join(',')}:${Date.now()}`;
      restoreIds.push(restoreId);
      addPendingRestore(sessionId, telegramId, {
        id: restoreId, groupJid, participants: nonBotTargets,
        action: 'promote', reason: 'antidemote_restore',
      });
      restoreOps.push(
        retryGroupUpdate(socket, groupJid, nonBotTargets, 'promote').then((ok) => {
          audit.restoreSuccess = ok;
          if (ok) {
            removePendingRestore(sessionId, telegramId, restoreId);
          } else {
            audit.errors?.push('restore_failed_all_attempts');
          }
        })
      );
    }

    if (hasBotInTargets) {
      // Already restored in step 1; record result.
      audit.restoreSuccess = botRestored;
    }

    audit.event          = 'unauthorized_demote';
    audit.enforcementMode = modeStr;

    const plan = buildActionPlan(mod.mode);

    // Run restores concurrently with punishment setup.
    await Promise.allSettled(restoreOps);

    // ── Step 7: Punishment ───────────────────────────────────
    // If the ONLY enforcement target was the bot and restore failed,
    // punishment is skipped (spec requirement: "Punishment cannot be executed").
    // If there are non-bot targets or bot was successfully restored, punish.
    const canPunish = !(hasBotInTargets && !botRestored && nonBotTargets.length === 0);
    if (!canPunish) {
      logger.warn('[SecurityEngine] AntiDemote: bot restore failed — skipping punishment', {
        sessionId, groupJid, actorJid,
      });
      return;
    }

    await executePunishment({
      socket, sessionId, telegramId, groupJid,
      actorJid, targetJids: enforcementTargets,
      plan,
      eventLabel: 'Unauthorized Demotion',
      customMessage: mod.customMessage,
      audit,
    });

    logger.info('[SecurityEngine] AntiDemote enforced', {
      sessionId, groupJid, actorJid, targetMode, mode: modeStr,
    });

  } catch (err) {
    audit.success = false;
    audit.errors?.push(`engine_error:${String(err)}`);
    logger.error('[SecurityEngine] AntiDemote engine error', {
      err: String(err), sessionId, groupJid,
    });
  } finally {
    logAudit(audit, startMs);
  }
}

// ══════════════════════════════════════════════════════════
// AntiPromote Engine
// ══════════════════════════════════════════════════════════
//
// Processing flow:
//   1. Guard: module enabled?
//   2. Guard: actor known?
//   3. Determine enforcement targets by targetMode
//   4. Guard: any protected target was promoted?
//   5. Guard: bot is admin?
//   6. Revert promotions
//   7. Execute punishment against actor
//   8. Audit (single finally block)
//
// Target mode 'protected':
//   All promotions are ignored. In 'protected' mode the bot is the
//   only entity of concern, and promoting the bot (already an admin)
//   is a no-op that should be ignored.
//
// Target mode 'admins':
//   Any promotion of a member to admin is unauthorized.
//   Promoting the bot is still ignored (it is already admin).

export async function handleAntiPromoteEvent(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  update: ParticipantUpdateEvent
): Promise<void> {
  if (update.action !== 'promote') return;

  const startMs    = Date.now();
  const groupJid   = update.id;
  const targetJids  = update.participants;
  const actorJid   = update.author ?? '';

  const sock = socket as unknown as { user?: { id?: string } };
  const rawBotJid = sock.user?.id ?? '';
  const botNum    = rawBotJid ? numericId(rawBotJid) : '';

  const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const mod = gc.antipromote as AntiPromoteConfig | undefined;
  const targetMode: TargetMode = mod?.targetMode ?? 'protected';
  const modeStr = mod ? String(mod.mode) : 'off';

  const audit = makeAudit(
    telegramId, sessionId, groupJid, actorJid, targetJids,
    'skipped', modeStr, targetMode
  );

  try {
    // ── Step 1: Module enabled? ──────────────────────────────
    if (!mod?.enabled || mod.mode === 'off') {
      audit.skipReason     = 'Module Disabled';
      audit.executedActions = ['audit'];
      logger.debug('[SecurityEngine] AntiPromote disabled', { sessionId, groupJid });
      return;
    }

    // ── Step 2: Actor known? ────────────────────────────────
    if (!actorJid) {
      audit.skipReason     = 'Invalid Actor';
      audit.executedActions = ['audit'];
      logger.debug('[SecurityEngine] AntiPromote: no author in event', { sessionId, groupJid });
      return;
    }

    const actorNumber = normalizeNumber(actorJid);

    // ── Step 3: Determine enforcement targets ────────────────
    // targetMode 'protected':
    //   Bot is the only protected entity. Promoting the bot is harmless
    //   ("already admin" — spec says ignore). No other promotions trigger enforcement.
    //   Result: enforcement targets = empty → ignored.
    //
    // targetMode 'admins':
    //   Any member being promoted to admin is an unauthorized promotion.
    //   Exception: promoting the bot (already admin) is ignored.

    let enforcementTargets: string[];
    if (targetMode === 'protected') {
      // In 'protected' mode, AntiPromote has nothing to act on:
      //   - Bot promoted → ignore (already admin)
      //   - Others promoted → not our concern
      enforcementTargets = [];
    } else {
      // 'admins' mode: every promoted participant is a target,
      // EXCEPT the bot itself (bot is already admin — ignore).
      enforcementTargets = targetJids.filter((jid) => {
        const n = numericId(jid);
        return !n || n !== botNum;
      });
    }

    // ── Step 4: Any enforcement target? ─────────────────────
    if (enforcementTargets.length === 0) {
      audit.event      = 'skipped';
      audit.skipReason = 'Target not protected by current mode';
      audit.executedActions = ['audit'];
      logger.info('[SecurityEngine] AntiPromote: no enforcement targets', {
        sessionId, groupJid, targetMode,
      });
      return;
    }

    const targetNumbers = enforcementTargets.map((j) => normalizeNumber(j));

    // ── Step 5: Bot admin check ──────────────────────────────
    const botIsAdmin = await checkBotIsAdmin(socket, sessionId, groupJid);
    if (!botIsAdmin) {
      audit.event      = 'skipped';
      audit.skipReason = 'Bot is no longer Admin';
      audit.executedActions = ['audit'];
      logger.info('[SecurityEngine] AntiPromote: bot not admin, cannot enforce', {
        sessionId, groupJid,
      });
      return;
    }

    // ── Step 6: Revert promotions ────────────────────────────
    audit.event          = 'unauthorized_promote';
    audit.enforcementMode = modeStr;

    const plan = buildActionPlan(mod.mode);

    if (plan.restoreVictim) {
      const restoreId = `promote:${groupJid}:${enforcementTargets.join(',')}:${Date.now()}`;
      addPendingRestore(sessionId, telegramId, {
        id: restoreId, groupJid, participants: enforcementTargets,
        action: 'demote', reason: 'antipromote_revert',
      });
      const ok = await retryGroupUpdate(socket, groupJid, enforcementTargets, 'demote');
      audit.restoreSuccess = ok;
      if (ok) {
        removePendingRestore(sessionId, telegramId, restoreId);
      } else {
        audit.errors?.push('revert_promotion_failed_all_attempts');
      }
    }

    // ── Step 7: Punishment ───────────────────────────────────
    await executePunishment({
      socket, sessionId, telegramId, groupJid,
      actorJid, targetJids: enforcementTargets,
      plan,
      eventLabel: 'Unauthorized Promotion',
      customMessage: mod.customMessage,
      audit,
    });

    logger.info('[SecurityEngine] AntiPromote enforced', {
      sessionId, groupJid, actorJid, targetMode, mode: modeStr,
    });

  } catch (err) {
    audit.success = false;
    audit.errors?.push(`engine_error:${String(err)}`);
    logger.error('[SecurityEngine] AntiPromote engine error', {
      err: String(err), sessionId, groupJid,
    });
  } finally {
    logAudit(audit, startMs);
  }
}

// ── Reconnect Restore Drain ────────────────────────────────

export async function drainPendingRestores(
  socket: WASocket,
  sessionId: string,
  telegramId: string
): Promise<void> {
  const pending = loadPendingRestores(sessionId, telegramId);
  if (!pending.length) return;

  logger.info('[SecurityEngine] Draining pending restores after reconnect', {
    sessionId, count: pending.length,
  });

  for (const entry of pending) {
    try {
      const ok = await retryGroupUpdate(socket, entry.groupJid, entry.participants, entry.action, 3);
      if (ok) {
        removePendingRestore(sessionId, telegramId, entry.id);
        logger.info('[SecurityEngine] Pending restore succeeded', {
          sessionId, groupJid: entry.groupJid, action: entry.action, reason: entry.reason,
        });
      } else {
        logger.warn('[SecurityEngine] Pending restore still failing, will retry next reconnect', {
          sessionId, groupJid: entry.groupJid, reason: entry.reason,
        });
      }
    } catch (err) {
      logger.warn('[SecurityEngine] Pending restore threw', {
        sessionId, groupJid: entry.groupJid, err: String(err),
      });
    }
  }
}

// ============================================================
// Group Security Engine — AntiPromote + AntiDemote (v2)
// ============================================================
//
// Production-grade security subsystem.  Every administrative
// action is monitored regardless of who performs it.
//
// Architectural principles:
//   • Detection ≠ Punishment.
//     Detection always occurs; punishment only for actors
//     classified as WA_ADMIN or NONE.
//   • Every promote/demote event produces either a security
//     action or a recorded audit entry.  Silent exits are
//     forbidden — even disabled/no-author events are audited.
//   • A single `finally` block writes the audit.  No branch
//     ever calls logAudit directly.
//   • Authorization logic lives in security-authorization.ts
//     (shared by all moderation modules).
//   • Actions are chainable; behaviour is never hardcoded.
//   • Legacy modes (dwp/dnp/kwp/knp) are fully supported
//     via a compatibility layer.
//   • The bot protects its own admin status and explains
//     every enforcement skip.
//
// Scope:
//   This engine is authoritative for AntiPromote and AntiDemote.
//   Other moderation modules (AutoBlock, AntiLink, AntiSpam, etc.)
//   currently use the legacy isProtectedJid helper which exempts all
//   WhatsApp admins.  Migrating those modules is a separate follow-up.
//
// Entry points:
//   handleAntiPromoteEvent(socket, sessionId, telegramId, update)
//   handleAntiDemoteEvent (socket, sessionId, telegramId, update)
//   drainPendingRestores  (socket, sessionId, telegramId)
//
// Validation matrix (all branches covered):
//   ✓ Global Owner promotes     → detected, logged, no punishment
//   ✓ Global Owner demotes      → detected, logged, no punishment
//   ✓ Session Owner promotes    → detected, logged, no punishment
//   ✓ Trusted Admin promotes    → detected, logged, no punishment
//   ✓ Trusted Admin demotes     → detected, logged, no punishment
//   ✓ Normal Admin promotes     → AntiPromote executes
//   ✓ Normal Admin demotes      → AntiDemote executes
//   ✓ Bot is demoted            → Self-Protection Engine triggers
//   ✓ Bot cannot recover        → Group receives recovery message
//   ✓ Module disabled           → audited with skip reason
//   ✓ No author in event        → audited with skip reason
//   ✓ Legacy mode dwp           → REVERT + WARN
//   ✓ Legacy mode dnp           → REVERT
//   ✓ Legacy mode kwp           → KICK + WARN
//   ✓ Legacy mode knp           → KICK
//   ✓ Invalid mode              → error logged, safe fallback to WARN
//   ✓ Every branch produces either an action or an audit entry
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
import { classifyActor } from './security-authorization.js';
import { addPendingRestore, removePendingRestore, loadPendingRestores } from './pending-restores.js';
import type {
  GroupSecurityMode,
  LegacySecurityMode,
  SecurityAction,
  SecurityAuditLog,
  SecurityEventType,
  AntiPromoteConfig,
  AntiDemoteConfig,
  AuthorizationResult,
  SkipReason,
} from './types.js';

// ── Inline utility ─────────────────────────────────────────

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

// ── Legacy Mode Compatibility Layer ────────────────────────
//
// Maps legacy modes to modern action chains:
//   dwp → REVERT + WARN
//   dnp → REVERT
//   kwp → KICK + WARN
//   knp → KICK

const LEGACY_MODES = new Set<string>(['dwp', 'dnp', 'kwp', 'knp']);

function isLegacyMode(mode: string): mode is LegacySecurityMode {
  return LEGACY_MODES.has(mode);
}

// ── Action Plan ────────────────────────────────────────────

interface ActionPlan {
  actions: SecurityAction[];
  revertOp: 'demote' | 'promote' | null;
  isKick: boolean;
  isBan: boolean;
  label: string;
  penalty: string;
}

function buildActionPlan(
  mode: GroupSecurityMode,
  eventType: 'promote' | 'demote'
): ActionPlan {
  const revertOp = eventType === 'promote' ? 'demote' : 'promote';
  const revertAction: SecurityAction =
    eventType === 'promote' ? 'revert_promotion' : 'revert_demotion';
  const revertLabel =
    eventType === 'promote' ? 'Promotion Reverted' : 'Admin Rights Restored';

  if (isLegacyMode(mode)) {
    logger.info('[SecurityEngine] Legacy mode — mapping to modern engine', { mode });
    switch (mode) {
      case 'dwp':
        // REVERT + WARN: undo the role change AND warn the actor
        return { actions: [revertAction, 'warn', 'notify_group', 'audit'], revertOp, isKick: false, isBan: false, label: revertLabel, penalty: 'Warning Issued (legacy: dwp)' };
      case 'dnp':
        // REVERT only: undo the role change, no additional penalty
        return { actions: [revertAction, 'notify_group', 'audit'], revertOp, isKick: false, isBan: false, label: revertLabel, penalty: 'Reverted (legacy: dnp)' };
      case 'kwp':
        // KICK + WARN: penalize actor only — no role-change revert
        return { actions: ['kick', 'warn', 'notify_group', 'audit'], revertOp: null, isKick: true, isBan: false, label: 'Warning Issued', penalty: 'Actor Kicked + Warning (legacy: kwp)' };
      case 'knp':
        // KICK only: penalize actor only — no role-change revert
        return { actions: ['kick', 'notify_group', 'audit'], revertOp: null, isKick: true, isBan: false, label: 'Actor Kicked', penalty: 'Actor Kicked (legacy: knp)' };
    }
  }

  switch (mode) {
    case 'warn':
      return { actions: ['warn', 'notify_group', 'audit'], revertOp: null, isKick: false, isBan: false, label: 'Warning Issued', penalty: 'Warning Issued' };
    case 'revert':
      return { actions: [revertAction, 'notify_group', 'audit'], revertOp, isKick: false, isBan: false, label: revertLabel, penalty: revertLabel };
    case 'kick':
      return { actions: [revertAction, 'kick', 'notify_group', 'audit'], revertOp, isKick: true, isBan: false, label: revertLabel, penalty: 'Actor Kicked' };
    case 'ban':
      return { actions: [revertAction, 'ban', 'notify_group', 'audit'], revertOp, isKick: true, isBan: true, label: revertLabel, penalty: 'Actor Kicked & Blocked' };
    case 'off':
      return { actions: ['audit'], revertOp: null, isKick: false, isBan: false, label: 'Module Off', penalty: 'No Action' };
    default: {
      logger.error('[SecurityEngine] Unknown mode — falling back to WARN', { mode });
      return { actions: ['warn', 'notify_group', 'audit'], revertOp: null, isKick: false, isBan: false, label: `Unknown Mode (${String(mode)})`, penalty: 'Warning Issued (fallback)' };
    }
  }
}

// ── OMEGA Security Response Card ───────────────────────────

function buildSecurityCard(opts: {
  eventLabel: string;
  actorNumber: string;
  targetNumbers: string[];
  actionLabel: string;
  penaltyLabel: string;
  skipReason?: string;
}): string {
  const time = new Date().toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const targets = opts.targetNumbers.map((n) => `  ➜ @${n}`).join('\n');
  const skipLine = opts.skipReason
    ? `\nSkip Reason\n  ➜ ${opts.skipReason}\n`
    : '';
  return (
    `⟦ OMEGA • SECURITY ⟧\n\n` +
    `⚠ ${opts.eventLabel}\n\n` +
    `Actor\n  ➜ @${opts.actorNumber}\n\n` +
    `Target\n${targets}\n\n` +
    `Action\n  ➜ ${opts.actionLabel}\n\n` +
    `Penalty\n  ➜ ${opts.penaltyLabel}\n` +
    skipLine +
    `\nTime\n  ➜ ${time}`
  );
}

// ── Bot Self-Protection Engine ─────────────────────────────

async function handleBotSelfDemotion(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  groupJid: string
): Promise<void> {
  logger.warn('[SecurityEngine] Bot self-protection: bot was demoted', { sessionId, groupJid });

  const sock = socket as unknown as { user?: { id?: string } };
  const botJid = sock.user?.id ? stripDeviceSuffix(sock.user.id) : null;

  if (!botJid) {
    logger.error('[SecurityEngine] Bot self-protection: cannot resolve bot JID', { sessionId, groupJid });
    return;
  }

  const restored = await retryGroupUpdate(socket, groupJid, [botJid], 'promote', 3);

  if (restored) {
    logger.info('[SecurityEngine] Bot self-protection: admin status restored', { sessionId, groupJid });
    try {
      await PreviewManager.send(
        socket as any, groupJid,
        `✅ Security Restored\n\nBot administrative privileges were temporarily removed.\nAutomatic enforcement has been restored.`,
        { sessionId, telegramId }
      );
    } catch { /* non-critical */ }
    return;
  }

  logger.error('[SecurityEngine] Bot self-protection: cannot restore admin status', { sessionId, groupJid });
  try {
    await PreviewManager.send(
      socket as any, groupJid,
      `❌ Security Alert\n\nBot administrative privileges were removed.\n\nAutomatic enforcement has been suspended.\n\nPlease promote the bot again to restore security.`,
      { sessionId, telegramId }
    );
  } catch (err) {
    logger.warn('[SecurityEngine] Bot self-protection: failed to send recovery message', {
      err: String(err), sessionId, groupJid,
    });
  }
}

// ── Action Executor ────────────────────────────────────────

interface ExecutionContext {
  socket: WASocket;
  sessionId: string;
  telegramId: string;
  groupJid: string;
  actorJid: string;
  actorNumber: string;
  targetJids: string[];
  targetNumbers: string[];
  plan: ActionPlan;
  eventLabel: string;
  auth: AuthorizationResult;
  audit: SecurityAuditLog;
  customMessage?: string;
}

async function executeActionPlan(ctx: ExecutionContext): Promise<void> {
  const {
    socket, sessionId, telegramId, groupJid,
    actorJid, actorNumber, targetJids, targetNumbers,
    plan, eventLabel, auth, audit, customMessage,
  } = ctx;

  const ops: Promise<unknown>[] = [];
  const executedActions: SecurityAction[] = [];

  for (const action of plan.actions) {
    switch (action) {

      case 'revert_promotion': {
        executedActions.push(action);
        const restoreId = `promote:${groupJid}:${targetJids.join(',')}:${Date.now()}`;
        addPendingRestore(sessionId, telegramId, {
          id: restoreId, groupJid, participants: targetJids,
          action: 'demote', reason: 'antipromote_revert',
        });
        ops.push(
          retryGroupUpdate(socket, groupJid, targetJids, 'demote').then((ok) => {
            audit.restoreSuccess = ok;
            if (ok) removePendingRestore(sessionId, telegramId, restoreId);
            else audit.errors?.push('revert_demote_failed_all_attempts');
          })
        );
        break;
      }

      case 'revert_demotion': {
        executedActions.push(action);
        const restoreId = `demote:${groupJid}:${targetJids.join(',')}:${Date.now()}`;
        addPendingRestore(sessionId, telegramId, {
          id: restoreId, groupJid, participants: targetJids,
          action: 'promote', reason: 'antidemote_revert',
        });
        ops.push(
          retryGroupUpdate(socket, groupJid, targetJids, 'promote').then((ok) => {
            audit.restoreSuccess = ok;
            if (ok) removePendingRestore(sessionId, telegramId, restoreId);
            else audit.errors?.push('restore_promote_failed_all_attempts');
          })
        );
        break;
      }

      case 'kick':
        executedActions.push(action);
        ops.push(
          retryGroupUpdate(socket, groupJid, [actorJid], 'remove').then((ok) => {
            if (!ok) audit.errors?.push('kick_actor_failed');
          })
        );
        break;

      case 'ban':
        executedActions.push(action);
        ops.push(
          retryGroupUpdate(socket, groupJid, [actorJid], 'remove').then((ok) => {
            if (!ok) audit.errors?.push('kick_actor_failed');
          })
        );
        ops.push(
          (socket as unknown as {
            updateBlockStatus(jid: string, action: string): Promise<unknown>;
          }).updateBlockStatus(actorJid, 'block').catch((err) => {
            audit.errors?.push(`block_actor_failed:${String(err)}`);
          })
        );
        break;

      case 'warn':
        // Warn is communicated through the notify_group card.
        executedActions.push(action);
        break;

      case 'notify_group': {
        executedActions.push(action);
        const card = buildSecurityCard({
          eventLabel, actorNumber, targetNumbers,
          actionLabel: plan.label, penaltyLabel: plan.penalty,
          skipReason: auth.skipReason,
        });
        ops.push(
          PreviewManager.send(socket as any, groupJid, customMessage ?? card, {
            extra: { mentions: [actorJid, ...targetJids] },
            sessionId, telegramId,
          }).catch((err) => {
            audit.errors?.push(`send_card_failed:${String(err)}`);
          })
        );
        break;
      }

      case 'delete_event':
        // Participant update events have no deletable message; reserved for future use.
        executedActions.push(action);
        break;

      case 'notify_owner':
        executedActions.push(action);
        logger.info('[SecurityEngine] notify_owner (not yet implemented)', { sessionId, groupJid, actorJid });
        break;

      case 'notify_telegram':
        executedActions.push(action);
        logger.info('[SecurityEngine] notify_telegram (not yet implemented)', { sessionId, groupJid, actorJid });
        break;

      case 'audit':
        // Emitted by the single `finally` logAudit call; tracked here for the record.
        executedActions.push(action);
        break;
    }
  }

  audit.executedActions = executedActions;
  if (ops.length > 0) await Promise.allSettled(ops);
}

// ── Audit Log ──────────────────────────────────────────────
// Single emission point — always called from `finally`.
// No function other than `finally` may call logAudit.

function logAudit(audit: SecurityAuditLog, startMs: number): void {
  audit.durationMs = Date.now() - startMs;
  const level = audit.success ? 'info' : 'error';
  logger[level]('[SecurityEngine] SecurityAudit', {
    timestamp:            audit.timestamp,
    workspaceId:          audit.workspaceId,
    sessionId:            audit.sessionId,
    groupId:              audit.groupId,
    groupName:            audit.groupName,
    actorJid:             audit.actorJid,
    actorNumber:          audit.actorNumber,
    actorPermissionLevel: audit.actorPermissionLevel,
    targets:              audit.targetJids,
    event:                audit.event,
    enforcementMode:      audit.enforcementMode,
    executedActions:      audit.executedActions,
    skipReason:           audit.skipReason,
    restoreSuccess:       audit.restoreSuccess,
    success:              audit.success,
    durationMs:           audit.durationMs,
    errors:               audit.errors?.length ? audit.errors : undefined,
  });
}

// ── Blank Audit Factory ────────────────────────────────────
// Creates a minimal audit record that can be filled in as the
// handler progresses.  Created before any early-exit path so
// every event always produces one audit entry.

function makeAudit(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  actorJid: string,
  targetJids: string[],
  event: SecurityEventType,
  enforcementMode: string
): SecurityAuditLog {
  return {
    timestamp:            new Date().toISOString(),
    workspaceId:          telegramId,
    sessionId,
    groupId:              groupJid,
    groupName:            groupJid.split('@')[0] ?? '',
    actorJid,
    actorNumber:          normalizeNumber(actorJid),
    actorPermissionLevel: 'NONE',
    targetJids,
    event,
    enforcementMode,
    executedActions:      [],
    success:              true,   // optimistic; set false on engine error
    durationMs:           0,
    errors:               [],
  };
}

// ── AntiPromote Engine ─────────────────────────────────────

/**
 * Process a 'promote' participant event.
 *
 * Targets = the participants who WERE promoted.
 * Actor   = the admin who performed the promotion.
 *
 * Every event is audited — including disabled-module and no-author
 * cases.  The audit is written in the single `finally` block.
 * No branch calls logAudit directly.
 */
export async function handleAntiPromoteEvent(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  update: ParticipantUpdateEvent
): Promise<void> {
  if (update.action !== 'promote') return;

  const startMs    = Date.now();
  const groupJid   = update.id;
  const actorJid   = update.author ?? '';
  const targetJids  = update.participants;

  const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const mod = gc.antipromote as AntiPromoteConfig | undefined;

  // Audit is created NOW — before any early exit — so every event is recorded.
  const audit = makeAudit(
    telegramId, sessionId, groupJid, actorJid, targetJids,
    'detected_promote',
    mod ? String(mod.mode) : 'off'
  );

  try {
    // ── Module disabled ──────────────────────────────────────
    if (!mod?.enabled || mod.mode === 'off') {
      audit.skipReason     = 'Module Disabled';
      audit.executedActions = ['audit'];
      logger.debug('[SecurityEngine] AntiPromote disabled', { sessionId, groupJid });
      return; // finally will write the audit
    }

    // ── No author — cannot determine who performed the action ─
    if (!actorJid) {
      audit.skipReason     = 'Invalid Actor';
      audit.executedActions = ['audit'];
      logger.debug('[SecurityEngine] AntiPromote: no author in event', { sessionId, groupJid });
      return;
    }

    const actorNumber   = normalizeNumber(actorJid);
    const targetNumbers = targetJids.map((j) => normalizeNumber(j));

    // ── Authorization ────────────────────────────────────────
    const auth = await classifyActor(
      socket, sessionId, telegramId, groupJid, actorJid, mod.permitList ?? []
    );
    audit.actorPermissionLevel = auth.level;

    logger.info('[SecurityEngine] AntiPromote event classified', {
      sessionId, groupJid, actorJid,
      permissionLevel: auth.level,
      isPunishable: auth.isPunishable,
      mode: mod.mode,
    });

    // ── Bot not admin — enforcement impossible ───────────────
    if (!auth.botIsAdmin) {
      audit.skipReason     = 'Bot is no longer Admin' as SkipReason;
      audit.executedActions = ['audit'];
      return;
    }

    // ── Bot acting on itself — skip ──────────────────────────
    if (auth.skipReason === 'Bot is Self') {
      audit.skipReason     = 'Bot is Self';
      audit.executedActions = ['audit'];
      return;
    }

    // ── Protected actor: detect + log, no punishment ─────────
    if (!auth.isPunishable) {
      audit.event      = 'detected_promote';
      audit.skipReason = auth.skipReason;
      audit.executedActions = ['audit', 'notify_group'];

      // Send a detection card (observe-only)
      const levelLabel = auth.skipReason ?? auth.level;
      const infoCard = buildSecurityCard({
        eventLabel:   `Promotion Detected — ${levelLabel}`,
        actorNumber,
        targetNumbers,
        actionLabel:  'Detected — No Enforcement',
        penaltyLabel: `Skipped: ${levelLabel}`,
        skipReason:   auth.skipReason,
      });
      await PreviewManager.send(socket as any, groupJid, infoCard, {
        extra: { mentions: [actorJid, ...targetJids] },
        sessionId, telegramId,
      }).catch((err) => {
        audit.errors?.push(`send_detect_card_failed:${String(err)}`);
      });

      return;
    }

    // ── Punishable actor — build & execute action plan ────────
    audit.event          = 'unauthorized_promote';
    audit.enforcementMode = String(mod.mode);

    const plan = buildActionPlan(mod.mode, 'promote');

    await executeActionPlan({
      socket, sessionId, telegramId, groupJid,
      actorJid, actorNumber, targetJids, targetNumbers,
      plan,
      eventLabel: 'Unauthorized Promotion Detected',
      auth, audit,
      customMessage: mod.customMessage,
    });

  } catch (err) {
    audit.success = false;
    audit.errors?.push(`engine_error:${String(err)}`);
    logger.error('[SecurityEngine] AntiPromote engine error', {
      err: String(err), sessionId, groupJid,
    });
  } finally {
    // Single audit emission point — always reached.
    logAudit(audit, startMs);
  }
}

// ── AntiDemote Engine ──────────────────────────────────────

/**
 * Process a 'demote' participant event.
 *
 * Targets = the participants who WERE demoted.
 * Actor   = the admin who performed the demotion.
 *
 * Also triggers the Bot Self-Protection Engine when the bot
 * itself is among the demoted participants.  Bot protection
 * fires even when the AntiDemote module is disabled.
 *
 * Every event is audited.  Single `finally` emission.
 */
export async function handleAntiDemoteEvent(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  update: ParticipantUpdateEvent
): Promise<void> {
  if (update.action !== 'demote') return;

  const startMs    = Date.now();
  const groupJid   = update.id;
  const targetJids  = update.participants;
  const actorJid   = update.author ?? '';

  // ── Bot Self-Protection (fires regardless of module state) ──
  // Must happen before any module-enabled check so the bot can
  // defend itself even when AntiDemote is configured off.
  const sock = socket as unknown as { user?: { id?: string } };
  const rawBotJid = sock.user?.id ?? '';
  if (rawBotJid) {
    const botNum = numericId(rawBotJid);
    const botWasDemoted = botNum
      ? targetJids.some((jid) => numericId(jid) === botNum)
      : false;
    if (botWasDemoted) {
      await handleBotSelfDemotion(socket, sessionId, telegramId, groupJid);
    }
  }

  const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const mod = gc.antidemote as AntiDemoteConfig | undefined;

  // Audit is created NOW — before any early exit.
  const audit = makeAudit(
    telegramId, sessionId, groupJid, actorJid, targetJids,
    'detected_demote',
    mod ? String(mod.mode) : 'off'
  );

  try {
    // ── Module disabled ──────────────────────────────────────
    if (!mod?.enabled || mod.mode === 'off') {
      audit.skipReason     = 'Module Disabled';
      audit.executedActions = ['audit'];
      logger.debug('[SecurityEngine] AntiDemote disabled', { sessionId, groupJid });
      return;
    }

    // ── No author — cannot determine who performed the action ─
    if (!actorJid) {
      audit.skipReason     = 'Invalid Actor';
      audit.executedActions = ['audit'];
      logger.debug('[SecurityEngine] AntiDemote: no author in event', { sessionId, groupJid });
      return;
    }

    const actorNumber   = normalizeNumber(actorJid);
    const targetNumbers = targetJids.map((j) => normalizeNumber(j));

    // ── Authorization ────────────────────────────────────────
    const auth = await classifyActor(
      socket, sessionId, telegramId, groupJid, actorJid, mod.permitList ?? []
    );
    audit.actorPermissionLevel = auth.level;

    logger.info('[SecurityEngine] AntiDemote event classified', {
      sessionId, groupJid, actorJid,
      permissionLevel: auth.level,
      isPunishable: auth.isPunishable,
      mode: mod.mode,
    });

    // ── Bot not admin — enforcement impossible ───────────────
    if (!auth.botIsAdmin) {
      audit.skipReason     = 'Bot is no longer Admin' as SkipReason;
      audit.executedActions = ['audit'];
      return;
    }

    // ── Bot acting on itself — skip ──────────────────────────
    if (auth.skipReason === 'Bot is Self') {
      audit.skipReason     = 'Bot is Self';
      audit.executedActions = ['audit'];
      return;
    }

    // ── Protected actor: detect + log, no punishment ─────────
    if (!auth.isPunishable) {
      audit.event      = 'detected_demote';
      audit.skipReason = auth.skipReason;
      audit.executedActions = ['audit', 'notify_group'];

      const levelLabel = auth.skipReason ?? auth.level;
      const infoCard = buildSecurityCard({
        eventLabel:   `Demotion Detected — ${levelLabel}`,
        actorNumber,
        targetNumbers,
        actionLabel:  'Detected — No Enforcement',
        penaltyLabel: `Skipped: ${levelLabel}`,
        skipReason:   auth.skipReason,
      });
      await PreviewManager.send(socket as any, groupJid, infoCard, {
        extra: { mentions: [actorJid, ...targetJids] },
        sessionId, telegramId,
      }).catch((err) => {
        audit.errors?.push(`send_detect_card_failed:${String(err)}`);
      });

      return;
    }

    // ── Punishable actor — build & execute action plan ────────
    audit.event          = 'unauthorized_demote';
    audit.enforcementMode = String(mod.mode);

    const plan = buildActionPlan(mod.mode, 'demote');

    await executeActionPlan({
      socket, sessionId, telegramId, groupJid,
      actorJid, actorNumber, targetJids, targetNumbers,
      plan,
      eventLabel: 'Unauthorized Demotion Detected',
      auth, audit,
      customMessage: mod.customMessage,
    });

  } catch (err) {
    audit.success = false;
    audit.errors?.push(`engine_error:${String(err)}`);
    logger.error('[SecurityEngine] AntiDemote engine error', {
      err: String(err), sessionId, groupJid,
    });
  } finally {
    // Single audit emission point — always reached.
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

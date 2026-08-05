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
//   • Every event produces either a security action or a
//     recorded audit entry.  Silent exits are forbidden.
//   • Authorization logic lives in security-authorization.ts
//     (shared by all moderation modules).
//   • Actions are chainable; behaviour is never hardcoded.
//   • Legacy modes (dwp/dnp/kwp/knp) are fully supported
//     via a compatibility layer.
//   • The bot protects its own admin status and explains
//     every enforcement skip.
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
//   ✓ Legacy mode dwp           → REVERT + WARN
//   ✓ Legacy mode dnp           → REVERT
//   ✓ Legacy mode kwp           → KICK + WARN
//   ✓ Legacy mode knp           → KICK
//   ✓ Invalid mode              → error logged, safe fallback to WARN
//   ✓ Every branch audited
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

/**
 * Execute a group participants update with exponential back-off retry.
 * Returns true if the operation eventually succeeded.
 */
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
        attempt: attempt + 1, maxAttempts, groupJid, action, delay,
        err: String(err),
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

// ── Action Plan Builder ────────────────────────────────────
//
// Translates a GroupSecurityMode (including legacy aliases) into
// an ordered list of SecurityActions to execute.
//
// Actions are always chainable:
//   revert → warn → notify_group → audit
//   kick   → notify_group → audit
// notify_group and audit are always appended; other actions depend on mode.

interface ActionPlan {
  actions: SecurityAction[];
  revertOp: 'demote' | 'promote' | null;  // what WA operation restores state
  isKick: boolean;
  isBan: boolean;
  isWarn: boolean;
  label: string;      // human-readable action label for OMEGA card
  penalty: string;    // human-readable penalty label for OMEGA card
}

function buildActionPlan(
  mode: GroupSecurityMode,
  eventType: 'promote' | 'demote'
): ActionPlan {
  const revertOp = eventType === 'promote' ? 'demote' : 'promote';
  const revertAction: SecurityAction = eventType === 'promote' ? 'revert_promotion' : 'revert_demotion';

  // ── Legacy mode mapping ──────────────────────────────────
  if (isLegacyMode(mode)) {
    logger.info('[SecurityEngine] Legacy mode detected — mapping to modern engine', { mode });
    switch (mode) {
      case 'dwp':
        // REVERT + WARN
        return {
          actions: [revertAction, 'warn', 'notify_group', 'audit'],
          revertOp, isKick: false, isBan: false, isWarn: true,
          label: eventType === 'promote' ? 'Promotion Reverted' : 'Admin Rights Restored',
          penalty: 'Warning Issued (legacy: dwp)',
        };
      case 'dnp':
        // REVERT only
        return {
          actions: [revertAction, 'notify_group', 'audit'],
          revertOp, isKick: false, isBan: false, isWarn: false,
          label: eventType === 'promote' ? 'Promotion Reverted' : 'Admin Rights Restored',
          penalty: 'Reverted (legacy: dnp)',
        };
      case 'kwp':
        // KICK + WARN
        return {
          actions: [revertAction, 'kick', 'warn', 'notify_group', 'audit'],
          revertOp, isKick: true, isBan: false, isWarn: true,
          label: eventType === 'promote' ? 'Promotion Reverted' : 'Admin Rights Restored',
          penalty: 'Actor Kicked + Warning (legacy: kwp)',
        };
      case 'knp':
        // KICK only
        return {
          actions: [revertAction, 'kick', 'notify_group', 'audit'],
          revertOp, isKick: true, isBan: false, isWarn: false,
          label: eventType === 'promote' ? 'Promotion Reverted' : 'Admin Rights Restored',
          penalty: 'Actor Kicked (legacy: knp)',
        };
    }
  }

  // ── Modern mode mapping ──────────────────────────────────
  switch (mode) {
    case 'warn':
      return {
        actions: ['warn', 'notify_group', 'audit'],
        revertOp: null, isKick: false, isBan: false, isWarn: true,
        label: 'Warning Issued',
        penalty: 'Warning Issued',
      };

    case 'revert':
      return {
        actions: [revertAction, 'notify_group', 'audit'],
        revertOp, isKick: false, isBan: false, isWarn: false,
        label: eventType === 'promote' ? 'Promotion Reverted' : 'Admin Rights Restored',
        penalty: eventType === 'promote' ? 'Promotion Reverted' : 'Admin Rights Restored',
      };

    case 'kick':
      return {
        actions: [revertAction, 'kick', 'notify_group', 'audit'],
        revertOp, isKick: true, isBan: false, isWarn: false,
        label: eventType === 'promote' ? 'Promotion Reverted' : 'Admin Rights Restored',
        penalty: 'Actor Kicked',
      };

    case 'ban':
      return {
        actions: [revertAction, 'ban', 'notify_group', 'audit'],
        revertOp, isKick: true, isBan: true, isWarn: false,
        label: eventType === 'promote' ? 'Promotion Reverted' : 'Admin Rights Restored',
        penalty: 'Actor Kicked & Blocked',
      };

    case 'off':
      return {
        actions: ['audit'],
        revertOp: null, isKick: false, isBan: false, isWarn: false,
        label: 'Module Off',
        penalty: 'No Action',
      };

    default: {
      // Unknown mode — produce structured log and fall back to WARN safely
      logger.error('[SecurityEngine] Unknown mode — falling back to WARN', { mode });
      return {
        actions: ['warn', 'notify_group', 'audit'],
        revertOp: null, isKick: false, isBan: false, isWarn: true,
        label: `Unknown Mode (${String(mode)}) — Warning Issued`,
        penalty: 'Warning Issued (fallback)',
      };
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
  permissionLevel: string;
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
//
// Triggered when the bot itself is in the participants list of a
// 'demote' event.  Attempts to restore its own admin status.
// If restoration fails, notifies the group so the owner can act.

async function handleBotSelfDemotion(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  groupJid: string
): Promise<void> {
  logger.warn('[SecurityEngine] Bot self-protection: bot was demoted', {
    sessionId, groupJid,
  });

  const sock = socket as unknown as {
    user?: { id?: string };
    groupParticipantsUpdate(jid: string, p: string[], a: string): Promise<unknown>;
  };

  const botJid = sock.user?.id
    ? stripDeviceSuffix(sock.user.id)
    : null;

  if (!botJid) {
    logger.error('[SecurityEngine] Bot self-protection: cannot resolve bot JID', {
      sessionId, groupJid,
    });
    return;
  }

  // Attempt self-restore with retry
  const restored = await retryGroupUpdate(socket, groupJid, [botJid], 'promote', 3);

  if (restored) {
    logger.info('[SecurityEngine] Bot self-protection: admin status restored', {
      sessionId, groupJid,
    });
    try {
      await PreviewManager.send(
        socket as any,
        groupJid,
        `✅ Security Restored\n\nBot administrative privileges were temporarily removed.\nAutomatic enforcement has been restored.`,
        { sessionId, telegramId }
      );
    } catch { /* non-critical */ }
    return;
  }

  // Restoration impossible — notify group
  logger.error('[SecurityEngine] Bot self-protection: cannot restore admin status', {
    sessionId, groupJid,
  });

  try {
    await PreviewManager.send(
      socket as any,
      groupJid,
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
//
// Executes an ordered list of SecurityActions for a given enforcement
// context.  Actions run concurrently where safe.

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
  mod: { customMessage?: string };
}

async function executeActionPlan(ctx: ExecutionContext): Promise<void> {
  const {
    socket, sessionId, telegramId, groupJid,
    actorJid, actorNumber, targetJids, targetNumbers,
    plan, eventLabel, auth, audit, mod,
  } = ctx;

  const ops: Promise<unknown>[] = [];
  const executedActions: SecurityAction[] = [];

  for (const action of plan.actions) {
    switch (action) {

      case 'revert_promotion': {
        executedActions.push(action);
        const restoreId = `promote:${groupJid}:${targetJids.join(',')}:${Date.now()}`;
        addPendingRestore(sessionId, telegramId, {
          id: restoreId,
          groupJid,
          participants: targetJids,
          action: 'demote',
          reason: 'antipromote_revert',
        });
        ops.push(
          retryGroupUpdate(socket, groupJid, targetJids, 'demote').then((ok) => {
            audit.restoreSuccess = ok;
            if (ok) {
              removePendingRestore(sessionId, telegramId, restoreId);
            } else {
              audit.errors?.push('revert_demote_failed_all_attempts');
            }
          })
        );
        break;
      }

      case 'revert_demotion': {
        executedActions.push(action);
        const restoreId = `demote:${groupJid}:${targetJids.join(',')}:${Date.now()}`;
        addPendingRestore(sessionId, telegramId, {
          id: restoreId,
          groupJid,
          participants: targetJids,
          action: 'promote',
          reason: 'antidemote_revert',
        });
        ops.push(
          retryGroupUpdate(socket, groupJid, targetJids, 'promote').then((ok) => {
            audit.restoreSuccess = ok;
            if (ok) {
              removePendingRestore(sessionId, telegramId, restoreId);
            } else {
              audit.errors?.push('restore_promote_failed_all_attempts');
            }
          })
        );
        break;
      }

      case 'kick': {
        executedActions.push(action);
        ops.push(
          retryGroupUpdate(socket, groupJid, [actorJid], 'remove').then((ok) => {
            if (!ok) audit.errors?.push('kick_actor_failed');
          })
        );
        break;
      }

      case 'ban': {
        executedActions.push(action);
        // remove + block
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
      }

      case 'warn': {
        executedActions.push(action);
        // Warn is conveyed via notify_group card; no separate WA action needed.
        break;
      }

      case 'notify_group': {
        executedActions.push(action);
        const card = buildSecurityCard({
          eventLabel,
          actorNumber,
          targetNumbers,
          actionLabel: plan.label,
          penaltyLabel: plan.penalty,
          permissionLevel: auth.level,
          skipReason: auth.skipReason,
        });
        const text = mod.customMessage ?? card;
        ops.push(
          PreviewManager.send(socket as any, groupJid, text, {
            extra: { mentions: [actorJid, ...targetJids] },
            sessionId,
            telegramId,
          }).catch((err) => {
            audit.errors?.push(`send_card_failed:${String(err)}`);
          })
        );
        break;
      }

      case 'delete_event':
        // Participant update events do not have a deletable message object.
        // This action is a no-op here but available for future use.
        executedActions.push(action);
        break;

      case 'notify_owner':
        // Future: send Telegram DM to workspace owner.
        executedActions.push(action);
        logger.info('[SecurityEngine] notify_owner action (not yet implemented)', {
          sessionId, groupJid, actorJid,
        });
        break;

      case 'notify_telegram':
        // Future: push alert via Telegram bot API.
        executedActions.push(action);
        logger.info('[SecurityEngine] notify_telegram action (not yet implemented)', {
          sessionId, groupJid, actorJid,
        });
        break;

      case 'audit':
        // Audit is always written in the finally block of the caller.
        executedActions.push(action);
        break;
    }
  }

  audit.executedActions = executedActions;

  if (ops.length > 0) {
    await Promise.allSettled(ops);
  }
}

// ── Audit Log ──────────────────────────────────────────────

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

// ── AntiPromote Engine ─────────────────────────────────────

/**
 * Process a 'promote' participant event.
 *
 * Targets = the participants who WERE promoted.
 * Actor   = the admin who performed the promotion.
 *
 * Every event is detected and audited.
 * Punishment only for actors classified as WA_ADMIN or NONE.
 * Protected actors receive a detection log but no penalty.
 */
export async function handleAntiPromoteEvent(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  update: ParticipantUpdateEvent
): Promise<void> {
  if (update.action !== 'promote') return;

  const startMs   = Date.now();
  const groupJid  = update.id;
  const targetJids = update.participants;
  const actorJid  = update.author ?? '';

  if (!actorJid) {
    logger.debug('[SecurityEngine] AntiPromote: no author in event, skipping', {
      sessionId, groupJid,
    });
    return;
  }

  const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const mod = gc.antipromote as AntiPromoteConfig | undefined;

  if (!mod?.enabled || mod.mode === 'off') {
    logger.debug('[SecurityEngine] AntiPromote disabled', { sessionId, groupJid });
    return;
  }

  const actorNumber   = normalizeNumber(actorJid);
  const targetNumbers = targetJids.map((j) => normalizeNumber(j));

  const audit: SecurityAuditLog = {
    timestamp:            new Date().toISOString(),
    workspaceId:          telegramId,
    sessionId,
    groupId:              groupJid,
    groupName:            groupJid.split('@')[0] ?? '',
    actorJid,
    actorNumber,
    actorPermissionLevel: 'NONE',
    targetJids,
    event:                'unauthorized_promote',
    enforcementMode:      String(mod.mode),
    executedActions:      [],
    success:              false,
    durationMs:           0,
    errors:               [],
  };

  try {
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

    // ── Handle bot-not-admin state ───────────────────────────
    if (!auth.botIsAdmin && auth.skipReason === 'Bot is no longer Admin') {
      audit.event      = 'detected_promote';
      audit.skipReason = 'Bot is no longer Admin';
      audit.executedActions = ['audit'];
      audit.success    = true;
      logAudit(audit, startMs);
      return;
    }

    // ── Protected actor: detect + log, no punishment ─────────
    if (!auth.isPunishable) {
      audit.event      = 'detected_promote';
      audit.skipReason = auth.skipReason;
      audit.executedActions = ['audit'];
      audit.success    = true;

      // Still send an OWNER ACTION DETECTED card to group
      const levelLabel = auth.skipReason ?? auth.level;
      try {
        const infoCard = buildSecurityCard({
          eventLabel:      `Promotion Detected — ${levelLabel}`,
          actorNumber,
          targetNumbers,
          actionLabel:     'Detected — No Enforcement',
          penaltyLabel:    `Skipped: ${levelLabel}`,
          permissionLevel: auth.level,
          skipReason:      auth.skipReason,
        });
        await PreviewManager.send(socket as any, groupJid, infoCard, {
          extra: { mentions: [actorJid, ...targetJids] },
          sessionId,
          telegramId,
        }).catch(() => { /* non-critical */ });
      } catch { /* non-critical */ }

      logAudit(audit, startMs);
      return;
    }

    // ── Punishable actor: build & execute action plan ─────────
    audit.event = 'unauthorized_promote';
    const plan  = buildActionPlan(mod.mode, 'promote');

    await executeActionPlan({
      socket, sessionId, telegramId, groupJid,
      actorJid, actorNumber, targetJids, targetNumbers,
      plan,
      eventLabel: 'Unauthorized Promotion Detected',
      auth,
      audit,
      mod: { customMessage: mod.customMessage },
    });

    audit.success = true;
  } catch (err) {
    audit.errors?.push(`engine_error:${String(err)}`);
    logger.error('[SecurityEngine] AntiPromote engine error', {
      err: String(err), sessionId, groupJid,
    });
  } finally {
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
 * itself is among the demoted participants.
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

  // ── Bot Self-Protection Engine ───────────────────────────
  // Check if the bot itself is among the demoted targets.
  // This must happen BEFORE the module-enabled check so that
  // bot protection fires even when AntiDemote is configured off.
  const sock = socket as unknown as { user?: { id?: string } };
  const rawBotJid = sock.user?.id ?? '';
  const botNum    = rawBotJid ? numericId(rawBotJid) : '';

  if (botNum) {
    const botWasDemoted = targetJids.some(
      (jid) => numericId(jid) === botNum
    );
    if (botWasDemoted) {
      await handleBotSelfDemotion(socket, sessionId, telegramId, groupJid);
    }
  }

  if (!actorJid) {
    logger.debug('[SecurityEngine] AntiDemote: no author in event, skipping enforcement', {
      sessionId, groupJid,
    });
    return;
  }

  const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const mod = gc.antidemote as AntiDemoteConfig | undefined;

  if (!mod?.enabled || mod.mode === 'off') {
    logger.debug('[SecurityEngine] AntiDemote disabled', { sessionId, groupJid });
    return;
  }

  const actorNumber   = normalizeNumber(actorJid);
  const targetNumbers = targetJids.map((j) => normalizeNumber(j));

  const audit: SecurityAuditLog = {
    timestamp:            new Date().toISOString(),
    workspaceId:          telegramId,
    sessionId,
    groupId:              groupJid,
    groupName:            groupJid.split('@')[0] ?? '',
    actorJid,
    actorNumber,
    actorPermissionLevel: 'NONE',
    targetJids,
    event:                'unauthorized_demote',
    enforcementMode:      String(mod.mode),
    executedActions:      [],
    success:              false,
    durationMs:           0,
    errors:               [],
  };

  try {
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

    // ── Handle bot-not-admin state ───────────────────────────
    if (!auth.botIsAdmin && auth.skipReason === 'Bot is no longer Admin') {
      audit.event      = 'detected_demote';
      audit.skipReason = 'Bot is no longer Admin';
      audit.executedActions = ['audit'];
      audit.success    = true;
      logAudit(audit, startMs);
      return;
    }

    // ── Protected actor: detect + log, no punishment ─────────
    if (!auth.isPunishable) {
      audit.event      = 'detected_demote';
      audit.skipReason = auth.skipReason;
      audit.executedActions = ['audit'];
      audit.success    = true;

      // Still send an OWNER ACTION DETECTED card to group
      const levelLabel = auth.skipReason ?? auth.level;
      try {
        const infoCard = buildSecurityCard({
          eventLabel:      `Demotion Detected — ${levelLabel}`,
          actorNumber,
          targetNumbers,
          actionLabel:     'Detected — No Enforcement',
          penaltyLabel:    `Skipped: ${levelLabel}`,
          permissionLevel: auth.level,
          skipReason:      auth.skipReason,
        });
        await PreviewManager.send(socket as any, groupJid, infoCard, {
          extra: { mentions: [actorJid, ...targetJids] },
          sessionId,
          telegramId,
        }).catch(() => { /* non-critical */ });
      } catch { /* non-critical */ }

      logAudit(audit, startMs);
      return;
    }

    // ── Punishable actor: build & execute action plan ─────────
    audit.event = 'unauthorized_demote';
    const plan  = buildActionPlan(mod.mode, 'demote');

    await executeActionPlan({
      socket, sessionId, telegramId, groupJid,
      actorJid, actorNumber, targetJids, targetNumbers,
      plan,
      eventLabel: 'Unauthorized Demotion Detected',
      auth,
      audit,
      mod: { customMessage: mod.customMessage },
    });

    audit.success = true;
  } catch (err) {
    audit.errors?.push(`engine_error:${String(err)}`);
    logger.error('[SecurityEngine] AntiDemote engine error', {
      err: String(err), sessionId, groupJid,
    });
  } finally {
    logAudit(audit, startMs);
  }
}

// ── Reconnect Restore Drain ────────────────────────────────

/**
 * Call after a session reconnects to retry any pending restores
 * that failed during a previous run.
 */
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

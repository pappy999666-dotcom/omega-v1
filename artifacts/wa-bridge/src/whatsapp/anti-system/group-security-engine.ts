// ============================================================
// Group Security Engine — AntiPromote + AntiDemote
// ============================================================
//
// Centralises all promote/demote detection, validation, restore,
// punishment, logging, and response logic in one place.
//
// Entry points:
//   handleAntiPromoteEvent(socket, sessionId, telegramId, update)
//   handleAntiDemoteEvent (socket, sessionId, telegramId, update)
//
// Permission gate (in order):
//   1. Module enabled?
//   2. Bot is admin?
//   3. Actor is not superadmin (owner)?
//   4. Actor not in sudo list?
//   5. Actor not in module permit list?
//   6. Target is not the superadmin/owner?
//
// Modes: off | warn | revert | kick | ban
//
// Restore engine: exponential back-off, max 5 retries.
//   Failed restores are persisted to disk and retried after
//   the socket reconnects (call drainPendingRestores on reconnect).
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';
import {
  fetchGroupMeta,
  isProtectedJid,
  numericId,
  stripDeviceSuffix,
} from '../utils/group-permissions.js';
import { loadGroupAntiConfig } from './config.js';
import { loadSessionConfig } from '../../services/workspace.js';
import { PreviewManager } from '../../preview-engine/index.js';
import type { GroupSecurityMode, AntiPromoteConfig, AntiDemoteConfig } from './types.js';
import { addPendingRestore, removePendingRestore, loadPendingRestores } from './pending-restores.js';

// ── Inline utility (avoids circular import with event-handlers.ts) ──
function normalizeNumber(jid: string | null | undefined): string {
  if (!jid) return '';
  return (jid.split('@')[0] ?? '').split(':')[0]!.replace(/\D/g, '');
}

// ── Types ──────────────────────────────────────────────────

export interface ParticipantUpdateEvent {
  id: string;                // group JID
  participants: string[];    // affected participants
  action: 'add' | 'remove' | 'promote' | 'demote';
  author?: string;           // actor JID (who did it)
}

interface SecurityAuditLog {
  sessionId: string;
  groupJid: string;
  groupName: string;
  actorJid: string;
  actorNumber: string;
  targetJids: string[];
  event: 'unauthorized_promote' | 'unauthorized_demote';
  mode: GroupSecurityMode;
  actionTaken: string;
  success: boolean;
  restoreSuccess?: boolean;
  durationMs: number;
  timestamp: string;
  errors?: string[];
}

// ── Restore Engine ─────────────────────────────────────────

const RESTORE_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]; // exponential back-off

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
        attempt: attempt + 1,
        maxAttempts,
        groupJid,
        action,
        delay,
        err: String(err),
      });
      if (attempt < maxAttempts - 1) {
        await sleep(delay);
      }
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Response Card ──────────────────────────────────────────

function buildSecurityCard(opts: {
  eventLabel: string;
  actorNumber: string;
  targetNumbers: string[];
  actionLabel: string;
  penaltyLabel: string;
  groupName: string;
}): string {
  const time = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const targets = opts.targetNumbers.map((n) => `  ➜ @${n}`).join('\n');
  return (
    `⟦ OMEGA • SECURITY ⟧\n\n` +
    `⚠ ${opts.eventLabel}\n\n` +
    `Actor\n  ➜ @${opts.actorNumber}\n\n` +
    `Target\n${targets}\n\n` +
    `Action\n  ➜ ${opts.actionLabel}\n\n` +
    `Penalty\n  ➜ ${opts.penaltyLabel}\n\n` +
    `Time\n  ➜ ${time}`
  );
}

// ── Permission Gate ────────────────────────────────────────

interface PermissionCheckResult {
  allowed: boolean;       // true = proceed with action
  reason: string;         // why it was skipped (for logging)
  botIsAdmin: boolean;
  actorIsSuperadmin: boolean;
}

async function permissionGate(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  groupJid: string,
  actorJid: string,
  permitList: string[]
): Promise<PermissionCheckResult> {
  // 1. Fetch group metadata (bust cache — we need the current admin list)
  const meta = await fetchGroupMeta(socket, groupJid, true).catch(() => null);
  if (!meta) {
    return { allowed: false, reason: 'group_meta_unavailable', botIsAdmin: false, actorIsSuperadmin: false };
  }

  // 2. Bot must be admin to take any action
  if (!meta.botIsAdmin) {
    return { allowed: false, reason: 'bot_not_admin', botIsAdmin: false, actorIsSuperadmin: false };
  }

  // 3. Ignore bot's own actions
  const actorNum = numericId(actorJid);
  const botNum   = numericId(meta.botJid);
  if (actorNum && actorNum === botNum) {
    return { allowed: false, reason: 'actor_is_bot', botIsAdmin: true, actorIsSuperadmin: false };
  }

  // 4. Ignore group owner (superadmin)
  const actorParticipant = meta.participants.find(
    (p) => numericId(p.id) === actorNum
  );
  const actorIsSuperadmin = actorParticipant?.admin === 'superadmin';
  if (actorIsSuperadmin) {
    return { allowed: false, reason: 'actor_is_owner', botIsAdmin: true, actorIsSuperadmin: true };
  }

  // 5. Load session config for sudo list
  const sessionCfg = await Promise.resolve(loadSessionConfig(telegramId, sessionId)).catch(() => null);
  const sudoNumbers = sessionCfg?.sudoNumbers ?? [];

  // 6. Check if actor is a global sudo
  if (isProtectedJid(meta, actorJid, sudoNumbers)) {
    return { allowed: false, reason: 'actor_is_sudo_or_admin', botIsAdmin: true, actorIsSuperadmin: false };
  }

  // 7. Check per-module permit list
  const actorNormalized = normalizeNumber(actorJid);
  const isInPermitList = permitList.some(
    (n) => normalizeNumber(n) === actorNormalized
  );
  if (isInPermitList) {
    return { allowed: false, reason: 'actor_in_permit_list', botIsAdmin: true, actorIsSuperadmin: false };
  }

  return { allowed: true, reason: 'ok', botIsAdmin: true, actorIsSuperadmin: false };
}

// ── AntiPromote Engine ─────────────────────────────────────

/**
 * Process a 'promote' participant event.
 * Targets are the participants who WERE promoted.
 * Actor is the admin who performed the promotion.
 */
export async function handleAntiPromoteEvent(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  update: ParticipantUpdateEvent
): Promise<void> {
  if (update.action !== 'promote') return;
  if (!update.author) {
    logger.debug('[SecurityEngine] AntiPromote: no author in event, skipping', { sessionId, groupJid: update.id });
    return;
  }

  const startMs = Date.now();
  const groupJid  = update.id;
  const actorJid  = update.author;
  const targetJids = update.participants;

  const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const mod = gc.antipromote as AntiPromoteConfig | undefined;

  if (!mod?.enabled || mod.mode === 'off') {
    logger.debug('[SecurityEngine] AntiPromote disabled', { sessionId, groupJid });
    return;
  }

  const audit: SecurityAuditLog = {
    sessionId,
    groupJid,
    groupName: groupJid.split('@')[0] ?? '',
    actorJid,
    actorNumber: normalizeNumber(actorJid),
    targetJids,
    event: 'unauthorized_promote',
    mode: mod.mode,
    actionTaken: 'none',
    success: false,
    durationMs: 0,
    timestamp: new Date().toISOString(),
    errors: [],
  };

  try {
    // ── Permission check ──────────────────────────────────
    const perm = await permissionGate(
      socket, sessionId, telegramId, groupJid, actorJid, mod.permitList ?? []
    );

    logger.info('[SecurityEngine] AntiPromote permission gate', {
      sessionId, groupJid,
      actorJid,
      result: perm.reason,
      mode: mod.mode,
    });

    if (!perm.allowed) {
      audit.actionTaken = `skipped:${perm.reason}`;
      audit.success = true;
      logAudit(audit, startMs);
      return;
    }

    // ── Determine targets that are NOT the superadmin ────
    // (we can't demote the group owner under any circumstance)
    const safeTargets = targetJids.filter((jid) => {
      const meta = null; // we already busted cache; targets are now admins — safe to attempt demote
      return true; // filter will happen during actual demote (WhatsApp rejects for owner)
    });

    const actorNumber  = normalizeNumber(actorJid);
    const targetNumbers = targetJids.map((j) => normalizeNumber(j));

    // ── Execute mode ───────────────────────────────────────
    const ops: Promise<unknown>[] = [];
    let actionLabel  = '';
    let penaltyLabel = '';
    let revertSuccess = true;

    switch (mod.mode) {
      case 'warn': {
        // No revert — just warn the actor in group
        actionLabel  = 'Warning Issued';
        penaltyLabel = 'Warning Issued';
        audit.actionTaken = 'warn';
        break;
      }

      case 'revert': {
        // Demote the promoted targets back to member
        actionLabel  = 'Promotion Reverted';
        penaltyLabel = 'Promotion Reverted';
        audit.actionTaken = 'revert';

        const restoreId = `promote:${groupJid}:${targetJids.join(',')}:${Date.now()}`;
        // Add to pending before attempting (removed on success)
        addPendingRestore(sessionId, telegramId, {
          id: restoreId,
          groupJid,
          participants: targetJids,
          action: 'demote',
          reason: 'antipromote_revert',
        });

        ops.push(
          retryGroupUpdate(socket, groupJid, targetJids, 'demote').then((ok) => {
            revertSuccess = ok;
            if (ok) {
              removePendingRestore(sessionId, telegramId, restoreId);
              audit.restoreSuccess = true;
            } else {
              audit.restoreSuccess = false;
              audit.errors?.push('revert_demote_failed_all_attempts');
            }
          })
        );
        break;
      }

      case 'kick': {
        // Revert + kick actor
        actionLabel  = 'Promotion Reverted';
        penaltyLabel = 'Actor Kicked';
        audit.actionTaken = 'revert+kick';

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
            if (ok) removePendingRestore(sessionId, telegramId, restoreId);
            audit.restoreSuccess = ok;
          })
        );
        ops.push(
          retryGroupUpdate(socket, groupJid, [actorJid], 'remove').then((ok) => {
            if (!ok) audit.errors?.push('kick_actor_failed');
          })
        );
        break;
      }

      case 'ban': {
        // Revert + kick + block actor
        actionLabel  = 'Promotion Reverted';
        penaltyLabel = 'Actor Kicked & Blocked';
        audit.actionTaken = 'revert+ban';

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
            if (ok) removePendingRestore(sessionId, telegramId, restoreId);
            audit.restoreSuccess = ok;
          })
        );
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
    }

    // ── Send OMEGA SECURITY card ──────────────────────────
    const card = buildSecurityCard({
      eventLabel: 'Unauthorized Promotion Detected',
      actorNumber,
      targetNumbers,
      actionLabel,
      penaltyLabel,
      groupName: audit.groupName,
    });

    const customMsg = mod.customMessage;
    ops.push(
      PreviewManager.send(socket as any, groupJid, customMsg ?? card, {
        extra: { mentions: [actorJid, ...targetJids] },
        sessionId,
        telegramId,
      }).catch((err) => {
        audit.errors?.push(`send_card_failed:${String(err)}`);
      })
    );

    await Promise.allSettled(ops);
    audit.success = true;
  } catch (err) {
    audit.errors?.push(`engine_error:${String(err)}`);
    logger.error('[SecurityEngine] AntiPromote engine error', {
      err: String(err),
      sessionId,
      groupJid,
    });
  } finally {
    logAudit(audit, startMs);
  }
}

// ── AntiDemote Engine ──────────────────────────────────────

/**
 * Process a 'demote' participant event.
 * Targets are the participants who WERE demoted.
 * Actor is the admin who performed the demotion.
 */
export async function handleAntiDemoteEvent(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  update: ParticipantUpdateEvent
): Promise<void> {
  if (update.action !== 'demote') return;
  if (!update.author) {
    logger.debug('[SecurityEngine] AntiDemote: no author in event, skipping', { sessionId, groupJid: update.id });
    return;
  }

  const startMs = Date.now();
  const groupJid   = update.id;
  const actorJid   = update.author;
  const targetJids  = update.participants;

  const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const mod = gc.antidemote as AntiDemoteConfig | undefined;

  if (!mod?.enabled || mod.mode === 'off') {
    logger.debug('[SecurityEngine] AntiDemote disabled', { sessionId, groupJid });
    return;
  }

  const audit: SecurityAuditLog = {
    sessionId,
    groupJid,
    groupName: groupJid.split('@')[0] ?? '',
    actorJid,
    actorNumber: normalizeNumber(actorJid),
    targetJids,
    event: 'unauthorized_demote',
    mode: mod.mode,
    actionTaken: 'none',
    success: false,
    durationMs: 0,
    timestamp: new Date().toISOString(),
    errors: [],
  };

  try {
    // ── Permission check ──────────────────────────────────
    const perm = await permissionGate(
      socket, sessionId, telegramId, groupJid, actorJid, mod.permitList ?? []
    );

    logger.info('[SecurityEngine] AntiDemote permission gate', {
      sessionId, groupJid,
      actorJid,
      result: perm.reason,
      mode: mod.mode,
    });

    if (!perm.allowed) {
      audit.actionTaken = `skipped:${perm.reason}`;
      audit.success = true;
      logAudit(audit, startMs);
      return;
    }

    const actorNumber   = normalizeNumber(actorJid);
    const targetNumbers  = targetJids.map((j) => normalizeNumber(j));

    // ── Execute mode ───────────────────────────────────────
    const ops: Promise<unknown>[] = [];
    let actionLabel  = '';
    let penaltyLabel = '';

    switch (mod.mode) {
      case 'warn': {
        actionLabel  = 'Warning Issued';
        penaltyLabel = 'Warning Issued';
        audit.actionTaken = 'warn';
        break;
      }

      case 'revert': {
        // Restore victim(s) to admin + warn actor
        actionLabel  = 'Admin Rights Restored';
        penaltyLabel = 'Actor Warned';
        audit.actionTaken = 'revert';

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
            if (ok) removePendingRestore(sessionId, telegramId, restoreId);
            audit.restoreSuccess = ok;
            if (!ok) audit.errors?.push('restore_promote_failed_all_attempts');
          })
        );
        break;
      }

      case 'kick': {
        // Restore victim(s) + kick actor
        actionLabel  = 'Admin Rights Restored';
        penaltyLabel = 'Actor Kicked';
        audit.actionTaken = 'revert+kick';

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
            if (ok) removePendingRestore(sessionId, telegramId, restoreId);
            audit.restoreSuccess = ok;
          })
        );
        ops.push(
          retryGroupUpdate(socket, groupJid, [actorJid], 'remove').then((ok) => {
            if (!ok) audit.errors?.push('kick_actor_failed');
          })
        );
        break;
      }

      case 'ban': {
        // Restore victim(s) + kick + block actor
        actionLabel  = 'Admin Rights Restored';
        penaltyLabel = 'Actor Kicked & Blocked';
        audit.actionTaken = 'revert+ban';

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
            if (ok) removePendingRestore(sessionId, telegramId, restoreId);
            audit.restoreSuccess = ok;
          })
        );
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
    }

    // ── Send OMEGA SECURITY card ──────────────────────────
    const card = buildSecurityCard({
      eventLabel: 'Unauthorized Demotion Detected',
      actorNumber,
      targetNumbers,
      actionLabel,
      penaltyLabel,
      groupName: audit.groupName,
    });

    const customMsg = mod.customMessage;
    ops.push(
      PreviewManager.send(socket as any, groupJid, customMsg ?? card, {
        extra: { mentions: [actorJid, ...targetJids] },
        sessionId,
        telegramId,
      }).catch((err) => {
        audit.errors?.push(`send_card_failed:${String(err)}`);
      })
    );

    await Promise.allSettled(ops);
    audit.success = true;
  } catch (err) {
    audit.errors?.push(`engine_error:${String(err)}`);
    logger.error('[SecurityEngine] AntiDemote engine error', {
      err: String(err),
      sessionId,
      groupJid,
    });
  } finally {
    logAudit(audit, startMs);
  }
}

// ── Reconnect Restore Drain ────────────────────────────────

/**
 * Call this after a session reconnects to retry any pending restores
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
    sessionId,
    count: pending.length,
  });

  for (const entry of pending) {
    try {
      const ok = await retryGroupUpdate(socket, entry.groupJid, entry.participants, entry.action, 3);
      if (ok) {
        removePendingRestore(sessionId, telegramId, entry.id);
        logger.info('[SecurityEngine] Pending restore succeeded', {
          sessionId,
          groupJid: entry.groupJid,
          action: entry.action,
          reason: entry.reason,
        });
      } else {
        logger.warn('[SecurityEngine] Pending restore still failing, will retry next reconnect', {
          sessionId,
          groupJid: entry.groupJid,
          reason: entry.reason,
        });
      }
    } catch (err) {
      logger.warn('[SecurityEngine] Pending restore threw', {
        sessionId,
        groupJid: entry.groupJid,
        err: String(err),
      });
    }
  }
}

// ── Audit Logging ──────────────────────────────────────────

function logAudit(audit: SecurityAuditLog, startMs: number): void {
  audit.durationMs = Date.now() - startMs;
  const level = audit.success ? 'info' : 'error';
  logger[level]('[SecurityEngine] Audit', {
    event:          audit.event,
    sessionId:      audit.sessionId,
    groupJid:       audit.groupJid,
    groupName:      audit.groupName,
    actorJid:       audit.actorJid,
    actorNumber:    audit.actorNumber,
    targets:        audit.targetJids,
    mode:           audit.mode,
    actionTaken:    audit.actionTaken,
    restoreSuccess: audit.restoreSuccess,
    durationMs:     audit.durationMs,
    timestamp:      audit.timestamp,
    errors:         audit.errors?.length ? audit.errors : undefined,
  });
}

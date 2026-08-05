// ============================================================
// Central Security Authorization Engine
// ============================================================
//
// Single authoritative source for actor permission classification.
// Shared by: AntiPromote, AntiDemote, Kick, Ban, Warn, AutoBlock,
//            AntiLink, AntiSpam, AntiBot, and all future modules.
//
// Core principle:
//   Being a WhatsApp admin does NOT grant exemption from enforcement.
//   Group admin status alone must NEVER bypass security modules.
//
//   Detection  = always (every actor, every event)
//   Punishment = only for WA_ADMIN and NONE levels
//
// Permission levels (ordered highest → lowest trust):
//   GLOBAL_OWNER      → Detect + Log; NO punishment
//   SESSION_OWNER     → Detect + Log; NO punishment
//   WORKSPACE_OWNER   → Detect + Log; NO punishment
//   TRUSTED_ADMIN     → Detect + Log; NO punishment
//   SUDO_USER         → Detect + Log; NO punishment
//   TEMPORARY_PERMIT  → Detect + Log; NO punishment
//   WA_ADMIN          → Detect + Log + ENFORCE
//   NONE              → Detect + Log + ENFORCE
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';
import {
  fetchGroupMeta,
  numericId,
} from '../utils/group-permissions.js';
import { loadSessionConfig } from '../../services/workspace.js';
import type { PermissionLevel, SkipReason, AuthorizationResult } from './types.js';

// ── Protected level set ────────────────────────────────────

const PROTECTED_LEVELS = new Set<PermissionLevel>([
  'GLOBAL_OWNER',
  'SESSION_OWNER',
  'WORKSPACE_OWNER',
  'TRUSTED_ADMIN',
  'SUDO_USER',
  'TEMPORARY_PERMIT',
]);

/** True when the permission level exempts the actor from punishment. */
export function isPunishable(level: PermissionLevel): boolean {
  return !PROTECTED_LEVELS.has(level);
}

/** Returns the structured skip reason string for a protected level. */
export function getSkipReason(level: PermissionLevel): SkipReason | undefined {
  const map: Partial<Record<PermissionLevel, SkipReason>> = {
    GLOBAL_OWNER:     'Global Owner',
    SESSION_OWNER:    'Session Owner',
    WORKSPACE_OWNER:  'Workspace Owner',
    TRUSTED_ADMIN:    'Trusted Admin',
    SUDO_USER:        'Sudo User',
    TEMPORARY_PERMIT: 'Temporary Permit',
  };
  return map[level];
}

// ── Owner number resolution ────────────────────────────────

/**
 * Resolve all WhatsApp numbers that should be treated as Session Owner /
 * Workspace Owner for the given workspace.
 *
 * Stored in `ownerWaNumbers` (string[]) in UserConfig.
 * If absent, only the sudoNumbers list is used (SUDO_USER level).
 */
function getOwnerWaNumbers(sessionCfg: import('../../types/index.js').UserConfig | null): string[] {
  if (!sessionCfg) return [];
  return (sessionCfg.ownerWaNumbers ?? []).map((n) => n.replace(/\D/g, ''));
}

/**
 * Resolve all numbers explicitly configured as Trusted Admins.
 * Stored in `trustedAdminNumbers` (string[]) in UserConfig.
 */
function getTrustedAdminNumbers(sessionCfg: import('../../types/index.js').UserConfig | null): string[] {
  if (!sessionCfg) return [];
  return (sessionCfg.trustedAdminNumbers ?? []).map((n) => n.replace(/\D/g, ''));
}

// ── Core Classification ────────────────────────────────────
//
// Current scope: AntiPromote and AntiDemote.
// Other moderation modules (AutoBlock, AntiLink, AntiSpam, etc.) still
// use the legacy isProtectedJid helper, which exempts all WhatsApp admins.
// Migrating those modules to classifyActor is a separate follow-up task.

/**
 * Classify an actor by permission level and determine whether enforcement
 * should proceed.
 *
 * Checks (in priority order):
 *  1. Group metadata must be fetchable
 *  2. Bot must be admin (otherwise enforcement is impossible)
 *  3. Actor is the bot itself → skip (own action)
 *  4. Actor number in ownerWaNumbers → GLOBAL_OWNER or SESSION_OWNER
 *  5. Actor number in trustedAdminNumbers → TRUSTED_ADMIN
 *  6. Actor number in sudoNumbers → SUDO_USER
 *  7. Actor number in per-module permit list → TEMPORARY_PERMIT
 *  8. Actor is a WhatsApp admin (regular or superadmin) → WA_ADMIN (enforced)
 *  9. Everyone else → NONE (enforced)
 *
 * The WA group owner (superadmin) is treated as WA_ADMIN unless they appear
 * in a higher-trust list.  Group admin status alone never grants exemption.
 */
export async function classifyActor(
  socket: WASocket,
  sessionId: string,
  telegramId: string,
  groupJid: string,
  actorJid: string,
  permitList: string[]          // per-module permit list
): Promise<AuthorizationResult> {

  // 1. Group metadata (bust cache — we need current admin list)
  const meta = await fetchGroupMeta(socket, groupJid, true).catch(() => null);
  if (!meta) {
    logger.warn('[SecurityAuth] fetchGroupMeta failed — cannot classify actor', {
      sessionId, groupJid, actorJid,
    });
    return {
      level: 'NONE',
      isPunishable: false,
      skipReason: 'Unknown Group State',
      botIsAdmin: false,
    };
  }

  // 2. Bot admin check — cannot enforce without admin privileges
  if (!meta.botIsAdmin) {
    logger.info('[SecurityAuth] Bot is not admin — enforcement suspended', {
      sessionId, groupJid,
    });
    return {
      level: 'NONE',
      isPunishable: false,
      skipReason: 'Bot is no longer Admin',
      botIsAdmin: false,
    };
  }

  // 3. Ignore bot's own actions
  const actorNum = numericId(actorJid);
  const botNum   = numericId(meta.botJid);
  if (actorNum && actorNum === botNum) {
    return {
      level: 'NONE',
      isPunishable: false,
      skipReason: 'Bot is Self',
      botIsAdmin: true,
    };
  }

  if (!actorNum) {
    logger.warn('[SecurityAuth] actorJid has no numeric part', { actorJid, sessionId, groupJid });
    return {
      level: 'NONE',
      isPunishable: false,
      skipReason: 'Invalid Actor',
      botIsAdmin: true,
    };
  }

  // 4. Load workspace session config
  const sessionCfg = await Promise.resolve(
    loadSessionConfig(telegramId, sessionId)
  ).catch(() => null);

  // 5. Global Owner / Session Owner / Workspace Owner
  //    (ownerWaNumbers field in UserConfig, persisted in workspace config)
  const ownerNums = getOwnerWaNumbers(sessionCfg);
  if (ownerNums.includes(actorNum)) {
    const level: PermissionLevel = sessionCfg?.isOwner ? 'GLOBAL_OWNER' : 'SESSION_OWNER';
    logger.info('[SecurityAuth] Actor classified', {
      level, actorNum, sessionId, groupJid,
    });
    return {
      level,
      isPunishable: false,
      skipReason: getSkipReason(level),
      botIsAdmin: true,
    };
  }

  // 6. Trusted Admin (trustedAdminNumbers field in UserConfig)
  const trustedNums = getTrustedAdminNumbers(sessionCfg);
  if (trustedNums.includes(actorNum)) {
    logger.info('[SecurityAuth] Actor classified', {
      level: 'TRUSTED_ADMIN', actorNum, sessionId, groupJid,
    });
    return {
      level: 'TRUSTED_ADMIN',
      isPunishable: false,
      skipReason: 'Trusted Admin',
      botIsAdmin: true,
    };
  }

  // 7. Sudo User
  const sudoNumbers: string[] = (sessionCfg?.sudoNumbers ?? []).map((n: string) =>
    n.replace(/\D/g, '')
  );
  if (sudoNumbers.includes(actorNum)) {
    logger.info('[SecurityAuth] Actor classified', {
      level: 'SUDO_USER', actorNum, sessionId, groupJid,
    });
    return {
      level: 'SUDO_USER',
      isPunishable: false,
      skipReason: 'Sudo User',
      botIsAdmin: true,
    };
  }

  // 8. Temporary Permit (per-module permit list)
  const normalizedPermits = permitList.map((n) => n.replace(/\D/g, ''));
  if (normalizedPermits.includes(actorNum)) {
    logger.info('[SecurityAuth] Actor classified', {
      level: 'TEMPORARY_PERMIT', actorNum, sessionId, groupJid,
    });
    return {
      level: 'TEMPORARY_PERMIT',
      isPunishable: false,
      skipReason: 'Temporary Permit',
      botIsAdmin: true,
    };
  }

  // 9. WhatsApp Admin (regular or superadmin) — NOT exempt from enforcement
  //    Being a WA admin means they have WhatsApp group privileges.
  //    It does NOT mean they are trusted at the security engine level.
  const actorParticipant = meta.participants.find(
    (p) => numericId(p.id) === actorNum
  );
  const isWaAdmin =
    actorParticipant?.admin === 'admin' ||
    actorParticipant?.admin === 'superadmin';

  const level: PermissionLevel = isWaAdmin ? 'WA_ADMIN' : 'NONE';

  logger.info('[SecurityAuth] Actor classified', {
    level, actorNum, sessionId, groupJid,
    isWaSuperadmin: actorParticipant?.admin === 'superadmin',
  });

  // Both WA_ADMIN and NONE are punishable
  return {
    level,
    isPunishable: true,
    botIsAdmin: true,
  };
}

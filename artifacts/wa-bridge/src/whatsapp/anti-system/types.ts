// ============================================================
// Anti System — Type Definitions
// ============================================================

export type AntiAction = 'kick' | 'warn' | 'delete';

// ── Security Permission Levels ─────────────────────────────
//
// Ordered highest → lowest trust.
// Being a WhatsApp Admin is NOT a permission level that grants exemption.
// Group admin status alone must NEVER bypass AntiPromote or AntiDemote.
//
// Protected from punishment (still detected & audited):
//   GLOBAL_OWNER, SESSION_OWNER, WORKSPACE_OWNER,
//   TRUSTED_ADMIN, SUDO_USER, TEMPORARY_PERMIT
//
// Enforced against (no exemption):
//   WA_ADMIN, NONE

export type PermissionLevel =
  | 'GLOBAL_OWNER'       // Env TELEGRAM_OWNER_ID + configured owner WA number
  | 'SESSION_OWNER'      // isOwner in workspace config
  | 'WORKSPACE_OWNER'    // Alias for SESSION_OWNER (semantic clarity)
  | 'TRUSTED_ADMIN'      // Explicitly configured trusted numbers
  | 'SUDO_USER'          // sudoNumbers in workspace config
  | 'TEMPORARY_PERMIT'   // Per-module permit list
  | 'WA_ADMIN'           // WhatsApp group admin ONLY — NOT exempt from enforcement
  | 'NONE';              // Regular member

// ── Security Skip Reasons ──────────────────────────────────
//
// Every skipped enforcement must produce one of these.
// Silent exits are forbidden.

export type SkipReason =
  | 'Global Owner'
  | 'Session Owner'
  | 'Workspace Owner'
  | 'Trusted Admin'
  | 'Sudo User'
  | 'Temporary Permit'
  | 'Bot is Self'
  | 'Bot is no longer Admin'
  | 'Missing WhatsApp Permission'
  | 'Invalid Actor'
  | 'Unknown Group State'
  | 'Module Disabled';

// ── Security Actions ───────────────────────────────────────
//
// Actions are chainable.  Example chains:
//   REVERT → WARN → LOG
//   REVERT → KICK → LOG
//   WARN → TELEGRAM → AUDIT

export type SecurityAction =
  | 'revert_promotion'    // Demote the promoted targets back to member
  | 'revert_demotion'     // Re-promote the demoted targets back to admin
  | 'warn'                // Warn the actor in group
  | 'kick'                // Remove the actor from the group
  | 'ban'                 // Remove + block the actor
  | 'delete_event'        // Delete the offending event message (if available)
  | 'notify_group'        // Send OMEGA SECURITY card to the group
  | 'notify_owner'        // Notify the session owner (future: Telegram DM)
  | 'notify_telegram'     // Send alert to owner via Telegram bot
  | 'audit';              // Write structured security audit log entry

// ── Security Event Types ───────────────────────────────────

export type SecurityEventType =
  | 'unauthorized_promote'
  | 'unauthorized_demote'
  | 'detected_promote'    // Protected actor — detect only, no punishment
  | 'detected_demote'     // Protected actor — detect only, no punishment
  | 'bot_demoted'         // Bot's own admin was removed
  | 'bot_restored'        // Bot successfully re-promoted itself
  | 'bot_restore_failed'; // Bot could not recover its admin status

// ── Structured Security Audit Log ─────────────────────────
//
// Every enforcement decision — including skips — must produce one.

export interface SecurityAuditLog {
  timestamp: string;
  workspaceId: string;      // telegramId of the workspace owner
  sessionId: string;
  groupId: string;          // group JID
  groupName: string;
  actorJid: string;
  actorNumber: string;      // numeric part only
  actorPermissionLevel: PermissionLevel;
  targetJids: string[];
  event: SecurityEventType;
  enforcementMode: string;  // mode string as configured (incl. legacy)
  executedActions: SecurityAction[];
  skipReason?: SkipReason;  // populated when enforcement was skipped
  success: boolean;
  restoreSuccess?: boolean;
  durationMs: number;
  errors?: string[];
}

// ── Authorization Result ───────────────────────────────────

export interface AuthorizationResult {
  level: PermissionLevel;
  isPunishable: boolean;    // true = enforcement should proceed
  skipReason?: SkipReason;  // populated when isPunishable = false
  botIsAdmin: boolean;
}

// ── Legacy Mode Support ────────────────────────────────────
//
// Legacy modes are mapped to modern action chains:
//   dwp → REVERT + WARN
//   dnp → REVERT
//   kwp → KICK + WARN
//   knp → KICK
//
// Unknown modes produce structured logs and fall back safely.

export type LegacySecurityMode = 'dwp' | 'dnp' | 'kwp' | 'knp';

/** @deprecated Legacy mode kept for migration only */
export type AntiDemoteMode = LegacySecurityMode;

/**
 * Unified mode for AntiPromote and AntiDemote.
 *
 *  off    — module disabled
 *  warn   — send a warning card, no role change
 *  revert — undo the role change
 *  kick   — revert + kick the actor
 *  ban    — revert + kick + block the actor
 *  dwp    — legacy: REVERT + WARN
 *  dnp    — legacy: REVERT
 *  kwp    — legacy: KICK + WARN
 *  knp    — legacy: KICK
 */
export type GroupSecurityMode =
  | 'off'
  | 'warn'
  | 'revert'
  | 'kick'
  | 'ban'
  | LegacySecurityMode;

/** Base config shared by every anti module */
export interface AntiModuleConfig {
  enabled: boolean;
  action: AntiAction;
  warnThreshold: number;   // number of warns before kick (default 3)
  permitList: string[];    // normalized phone numbers exempt from this module
  customMessage?: string;  // override response template
}

/** AntiSpam extends with configurable window */
export interface AntiSpamConfig extends AntiModuleConfig {
  messageLimit: number;    // default 10
  windowSeconds: number;   // default 5
}

/** AntiWords extends with word list */
export interface AntiWordsConfig extends AntiModuleConfig {
  words: string[];         // lowercase blocked words/phrases
}

/**
 * AntiPromote module config.
 * Uses GroupSecurityMode (includes legacy mode aliases).
 */
export interface AntiPromoteConfig extends AntiModuleConfig {
  mode: GroupSecurityMode;
}

/** AntiDemote module config — unified mode system */
export interface AntiDemoteConfig extends AntiModuleConfig {
  mode: GroupSecurityMode;
  /** @deprecated kept for migration; handled by legacy compat layer */
  legacyMode?: AntiDemoteMode;
}

/** Full anti config for a single group */
export interface GroupAntiConfig {
  groupJid: string;
  antilink?: AntiModuleConfig;
  antibot?: AntiModuleConfig;
  antispam?: AntiSpamConfig;
  antipic?: AntiModuleConfig;
  antivid?: AntiModuleConfig;
  antiaud?: AntiModuleConfig;
  antivn?: AntiModuleConfig;
  antitxt?: AntiModuleConfig;
  antiemoji?: AntiModuleConfig;
  antisticker?: AntiModuleConfig;
  antigroupcall?: AntiModuleConfig;
  antinsfw?: AntiModuleConfig;
  antigroupmention?: AntiModuleConfig;
  antigm?: AntiModuleConfig;
  antiwords?: AntiWordsConfig;
  antipoll?: AntiModuleConfig;
  antiforward?: AntiModuleConfig;
  antichannel?: AntiModuleConfig;
  antipromote?: AntiPromoteConfig;
  antidemote?: AntiDemoteConfig;
  // Per-module custom response overrides
  messages?: Record<string, string>;
}

/** Per-session: all group anti configs */
export type SessionAntiConfig = Record<string, GroupAntiConfig>;

/** Violation context passed to action executor */
export interface ViolationContext {
  sessionId: string;
  telegramId: string;
  groupJid: string;
  senderJid: string;    // full JID with @s.whatsapp.net
  senderNumber: string; // normalized phone number
  moduleKey: keyof Omit<GroupAntiConfig, 'groupJid' | 'messages'>;
  moduleName: string;   // display name e.g. "AntiLink"
  moduleConfig: AntiModuleConfig;
  defaultMessage: string;
}

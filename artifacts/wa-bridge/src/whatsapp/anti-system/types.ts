// ============================================================
// Anti System — Type Definitions
// ============================================================

export type AntiAction = 'kick' | 'warn' | 'delete';

// ── Security Permission Levels ─────────────────────────────
//
// Still used by other moderation modules (AntiLink, AntiSpam, etc.).
// AntiPromote and AntiDemote no longer use permission levels —
// they use TargetMode instead.

export type PermissionLevel =
  | 'GLOBAL_OWNER'
  | 'SESSION_OWNER'
  | 'WORKSPACE_OWNER'
  | 'TRUSTED_ADMIN'
  | 'SUDO_USER'
  | 'TEMPORARY_PERMIT'
  | 'WA_ADMIN'
  | 'NONE';

// ── Target Mode ────────────────────────────────────────────
//
// Determines WHICH participants AntiPromote/AntiDemote protects.
//
//   protected (default)
//     Only the bot is a protected target.
//     AntiDemote: fires only when the bot is demoted.
//     AntiPromote: fires for any unauthorized promotion (to admin)
//                  EXCEPT promoting the bot (already admin — ignored).
//
//   admins
//     Every administrator is a protected target.
//     AntiDemote: fires when ANY admin is demoted.
//     AntiPromote: fires when ANY member is promoted to admin.
//
// No actor is exempt regardless of who they are (owner, trusted admin,
// sudo, workspace owner, etc.). The only entity inherently protected is
// the bot itself (in 'protected' mode) or every admin (in 'admins' mode).

export type TargetMode = 'protected' | 'admins';

// ── Security Skip Reasons ──────────────────────────────────
//
// Every skipped enforcement must produce one of these.
// Silent exits are forbidden.

export type SkipReason =
  // Used by AntiPromote / AntiDemote engine (v3)
  | 'Bot is Self'
  | 'Bot is no longer Admin'
  | 'Bot restore failed'
  | 'Missing WhatsApp Permission'
  | 'Invalid Actor'
  | 'Unknown Group State'
  | 'Module Disabled'
  | 'Target not protected by current mode'
  // Used by other modules (AntiLink, AntiSpam, etc.) via classifyActor
  | 'Global Owner'
  | 'Session Owner'
  | 'Workspace Owner'
  | 'Trusted Admin'
  | 'Sudo User'
  | 'Temporary Permit';

// ── Security Actions ───────────────────────────────────────
//
// Actions are chainable.  Example chains:
//   RESTORE → LOG
//   RESTORE → WARN → LOG
//   RESTORE → KICK → LOG
//   RESTORE → KICK → BAN → LOG

export type SecurityAction =
  | 'restore_target'   // Re-promote (AntiDemote) or re-demote (AntiPromote) the affected participant(s)
  | 'warn'             // Warn the actor in group
  | 'kick'             // Remove the actor from the group
  | 'demote'           // Demote the actor from admin
  | 'ban'              // Remove + block the actor
  | 'notify_group'     // Send OMEGA SECURITY card to the group
  | 'notify_owner'     // Notify the session owner (future: Telegram DM)
  | 'notify_telegram'  // Send alert to owner via Telegram bot
  | 'audit';           // Write structured security audit log entry

// Legacy action names (kept for type compat — mapped at use site)
export type LegacySecurityAction =
  | 'revert_promotion'
  | 'revert_demotion';

// ── Security Event Types ───────────────────────────────────

export type SecurityEventType =
  | 'unauthorized_promote'
  | 'unauthorized_demote'
  | 'bot_demoted'          // Bot's own admin was removed
  | 'bot_restored'         // Bot successfully re-promoted itself
  | 'bot_restore_failed'   // Bot could not recover its admin status
  | 'skipped';             // Enforcement skipped — see skipReason

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
  targetJids: string[];
  event: SecurityEventType;
  enforcementMode: string;  // punishment mode as configured (incl. legacy)
  targetMode: TargetMode;   // which targets are protected
  executedActions: SecurityAction[];
  skipReason?: SkipReason;  // populated when enforcement was skipped
  success: boolean;
  restoreSuccess?: boolean;
  durationMs: number;
  errors?: string[];
}

// ── Authorization Result ───────────────────────────────────
// Still used by other moderation modules via security-authorization.ts.

export interface AuthorizationResult {
  level: PermissionLevel;
  isPunishable: boolean;
  skipReason?: SkipReason;
  botIsAdmin: boolean;
}

// ── Legacy Mode Support ────────────────────────────────────
//
// Legacy modes are mapped to modern action chains:
//   dwp → demote actor, no restore
//   dnp → demote actor + restore victim
//   kwp → kick + warn actor, no restore
//   knp → kick actor only, no restore

export type LegacySecurityMode = 'dwp' | 'dnp' | 'kwp' | 'knp';

/** @deprecated Legacy mode kept for migration only */
export type AntiDemoteMode = LegacySecurityMode;

/**
 * Punishment mode for AntiPromote and AntiDemote.
 *
 * Canonical modes (v3):
 *   restore      — restore the victim only, no actor punishment
 *   restorewarn  — restore victim + warn actor in group
 *   restorekick  — restore victim + kick actor
 *   restoreban   — restore victim + kick + block actor
 *
 * Backward-compat aliases (map to canonical):
 *   revert       → restore
 *   warn         → restorewarn
 *   kick         → restorekick
 *   ban          → restoreban
 *
 * Enforcement modes (production semantics):
 *   knp          — K(ick) N(o-restore) P: kick actor, NO restore
 *   kwp          — K(ick) W(arn) P: kick + warn actor, NO restore
 *   dnp          — D(emote) N(o-restore) P: demote actor, restore victim
 *   dwp          — D(emote) W(arn) P: demote actor, NO restore
 *   jw           — J(ust) W(arn): warn actor only, NO restore, NO kick
 *   wnp          — W(arn) N(o-kick) P: warn actor + restore victim
 *
 * Restore operations always run BEFORE punishment when applicable.
 */
export type GroupSecurityMode =
  | 'off'
  // Canonical v3 modes:
  | 'restore'
  | 'restorewarn'
  | 'restorekick'
  | 'restoreban'
  // Backward-compat aliases:
  | 'revert'
  | 'warn'
  | 'kick'
  | 'ban'
  // Enforcement modes:
  | 'knp'
  | 'kwp'
  | 'dnp'
  | 'dwp'
  | 'jw'
  | 'wnp'
  // ── Action shorthand engine (v4) ────────────────────────────────
  //   d/p — Demote actor, promote victim (restore), notify everyone
  //   d/d — Demote actor, do NOT restore victim
  //   p/p — Promote victim (restore), warn actor, no actor demotion
  //   p/k — Promote victim (restore), kick actor
  | 'd/p'
  | 'd/d'
  | 'p/p'
  | 'p/k'
  //   restorewarn:<N> — restore victim + warn actor; after N warns the
  //   actor is kicked (punishment escalation). Parsed at runtime.
  | `restorewarn:${number}`
  // Legacy alias kept for migration:
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
 *
 * targetMode — who is protected from unauthorized promotions:
 *   'protected' (default) — nobody specifically; all promotions in 'admins' mode are flagged
 *   'admins'              — every promotion of a member to admin is reverted
 *
 * mode — what punishment is applied to the actor when enforcement triggers.
 */
export interface AntiPromoteConfig extends AntiModuleConfig {
  mode: GroupSecurityMode;
  targetMode: TargetMode;  // default: 'protected'
}

/**
 * AntiDemote module config.
 *
 * targetMode — who is protected from demotion:
 *   'protected' (default) — only the bot
 *   'admins'              — every administrator
 *
 * mode — what punishment is applied to the actor when enforcement triggers.
 */
export interface AntiDemoteConfig extends AntiModuleConfig {
  mode: GroupSecurityMode;
  targetMode: TargetMode;  // default: 'protected'
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
  /** AntiGStatus — blocks unauthorized Group Status posts */
  antigstatus?: AntiModuleConfig;
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

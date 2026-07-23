// ============================================================
// WA-Bridge — Error Recovery Trees
// Handles Baileys-specific error codes and auto-sanitation
// ============================================================

import { logger } from './logger.js';

export type BaileysErrorCode =
  | 401   // Unauthorized — session revoked
  | 408   // Timeout — connection timeout
  | 440   // Conflict — logged in elsewhere
  | 500   // Internal error
  | 'Bad MAC'       // Crypto mismatch — corrupted auth
  | 'Connection Failure'
  | 'Rate Limit'
  | 'Not Authorized'
  | 'No Internet'
  | 'Connection Lost';

export interface RecoveryAction {
  action: 'reconnect' | 'purge' | 'freeze' | 'alert' | 'ignore' | 'backoff';
  reason: string;
  alertUser?: boolean;
  purgeSession?: boolean;
}

/**
 * Classify a Baileys/WA error and return the appropriate recovery action.
 * This is the central error recovery decision tree.
 */
export function classifyBaileysError(err: unknown): RecoveryAction {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { output?: { statusCode?: number } })?.output?.statusCode;

  // ── 401 Unauthorized — session invalidated on server ──
  if (code === 401 || msg.includes('401') || msg.includes('Not Authorized')) {
    return {
      action: 'purge',
      reason: '401 Unauthorized — session revoked by WhatsApp',
      alertUser: true,
      purgeSession: true,
    };
  }

  // ── Bad MAC — corrupted auth state ──
  if (msg.includes('Bad MAC') || msg.includes('bad-mac')) {
    return {
      action: 'purge',
      reason: 'Bad MAC — authentication crypto corrupted, session unrecoverable',
      alertUser: true,
      purgeSession: true,
    };
  }

  // ── 440 Conflict — session opened on another device ──
  if (code === 440 || msg.includes('conflict')) {
    return {
      action: 'freeze',
      reason: '440 Conflict — device logged in elsewhere',
      alertUser: true,
    };
  }

  // ── 408 Timeout ──
  if (code === 408 || msg.includes('timeout') || msg.includes('Timed Out')) {
    return {
      action: 'reconnect',
      reason: '408 Timeout — transient connection issue, will retry',
      alertUser: false,
    };
  }

  // ── Rate limiting ──
  if (
    msg.includes('rate') ||
    msg.includes('429') ||
    msg.includes('rate-over-limit') ||
    msg.includes('spam')
  ) {
    return {
      action: 'backoff',
      reason: 'Rate limited — exponential backoff activated',
      alertUser: true,
    };
  }

  // ── Connection lost / no internet ──
  if (
    msg.includes('Connection Lost') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('No Internet')
  ) {
    return {
      action: 'reconnect',
      reason: 'Connection lost — will reconnect',
      alertUser: false,
    };
  }

  // ── Unknown / benign ──
  return {
    action: 'ignore',
    reason: `Unknown error: ${msg.slice(0, 100)}`,
    alertUser: false,
  };
}

/**
 * Log the recovery action with full context.
 */
export function logRecovery(
  sessionId: string,
  err: unknown,
  action: RecoveryAction
): void {
  const level = action.action === 'purge' ? 'error' : 'warn';
  logger.log(level, `[Recovery] ${sessionId} → ${action.action}`, {
    reason: action.reason,
    error: err instanceof Error ? err.message : String(err),
    purge: action.purgeSession,
    alertUser: action.alertUser,
  });
}

/**
 * Detect if an error means a WhatsApp group link is dead/invalid.
 */
export function isDeadLinkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('group-invite-invalid') ||
    msg.includes('invite-link-revoked') ||
    msg.includes('not-authorized') ||
    msg.includes('gone') ||
    msg.includes('group-join-failed') ||
    msg.includes('invite link has expired')
  );
}

/**
 * Detect if a group is full (cannot join).
 */
export function isGroupFullError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('group-full') || msg.includes('participant-limit');
}

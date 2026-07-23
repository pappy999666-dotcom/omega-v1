// ============================================================
// WA-Bridge — Error Recovery Trees
// Handles Baileys-specific error codes and auto-sanitation
// ============================================================

import { logger } from './logger.js';

export type BaileysErrorCode =
  | 401   // Unauthorized — session revoked
  | 403   // Forbidden
  | 408   // Timeout — connection timeout
  | 411   // Multi-device mismatch
  | 428   // Connection closed
  | 440   // Conflict — logged in elsewhere
  | 500   // Bad session / internal error
  | 503   // Service unavailable
  | 515   // Restart required after pairing
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
export function classifyBaileysError(
  err: unknown,
  context: { isRegisteredSession?: boolean } = {}
): RecoveryAction {
  const msg = err instanceof Error ? err.message : String(err);
  const candidate = err as { output?: { statusCode?: number }; statusCode?: number };
  const code = candidate?.output?.statusCode ?? candidate?.statusCode;

  // A pairing rejection must never delete an unregistered auth directory.
  if (code === 401 || msg.includes('401') || msg.includes('Not Authorized')) {
    return context.isRegisteredSession
      ? {
          action: 'purge',
          reason: '401 Unauthorized — registered session revoked by WhatsApp',
          alertUser: true,
          purgeSession: true,
        }
      : {
          action: 'freeze',
          reason: 'Pairing was rejected or expired — auth state preserved for a fresh attempt',
          alertUser: true,
        };
  }

  if (code === 515) {
    return {
      action: 'reconnect',
      reason: '515 Restart Required — completing the successful pairing handshake',
      alertUser: false,
    };
  }

  if (code === 428) {
    return {
      action: 'reconnect',
      reason: '428 Connection Closed — rebuilding the socket',
      alertUser: false,
    };
  }

  if (code === 411) {
    return {
      action: 'backoff',
      reason: '411 Multi-device mismatch — preserving auth and retrying safely',
      alertUser: true,
    };
  }

  if (code === 403) {
    return {
      action: 'freeze',
      reason: '403 Forbidden — session paused without deleting credentials',
      alertUser: true,
    };
  }

  if (code === 500) {
    return {
      action: 'backoff',
      reason: '500 Bad Session — preserving credentials and retrying with cooldown',
      alertUser: true,
    };
  }

  if (code === 503) {
    return {
      action: 'backoff',
      reason: '503 WhatsApp service unavailable — delayed retry scheduled',
      alertUser: false,
    };
  }

  // ── Bad MAC — often a recoverable out-of-order signal/session race ──
  if (msg.includes('Bad MAC') || msg.includes('bad-mac')) {
    return {
      action: 'backoff',
      reason: 'Bad MAC — preserving auth state and rebuilding the socket after backoff',
      alertUser: false,
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

  // ── Unknown socket closures are treated as transient ──
  return {
    action: 'backoff',
    reason: `Unclassified socket closure — preserving session: ${msg.slice(0, 100)}`,
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

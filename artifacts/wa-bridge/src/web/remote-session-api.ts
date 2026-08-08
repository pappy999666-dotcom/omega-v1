// ============================================================
// OMEGA — Remote Session Capability API helpers
//
// This module deliberately exposes no Baileys socket or auth-state
// objects. The HTTP layer uses it to authenticate a configured consumer
// and to fail closed when no session has been explicitly allowlisted.
// ============================================================

import crypto from 'crypto';

export type RemoteSessionStatus =
  | 'ACTIVE'
  | 'DISCONNECTED'
  | 'FROZEN'
  | 'PAIRING'
  | 'PURGED'
  | 'UNAVAILABLE';

const REMOTE_SESSION_STATUSES = new Set<RemoteSessionStatus>([
  'ACTIVE',
  'DISCONNECTED',
  'FROZEN',
  'PAIRING',
  'PURGED',
  'UNAVAILABLE',
]);

export interface RemoteSessionDescriptor {
  sessionId: string;
  label: string;
  status: RemoteSessionStatus;
  available: boolean;
  reason?: string;
}

export interface RemoteApiConfig {
  apiKey: string;
  allowedSessionIds: string[];
}

/**
 * Read integration credentials at request time so deployments can rotate the
 * key/allowlist without requiring a code change. Empty values fail closed.
 */
export function getRemoteApiConfig(
  env: NodeJS.ProcessEnv = process.env
): RemoteApiConfig {
  const apiKey = (env.OMEGA_WAIQ_API_KEY ?? env.WAIQ_API_KEY ?? '').trim();
  const rawAllowlist = env.OMEGA_WAIQ_SESSION_ALLOWLIST ?? env.WAIQ_OMEGA_SESSION_ALLOWLIST ?? '';
  const allowedSessionIds = rawAllowlist
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);

  return { apiKey, allowedSessionIds: [...new Set(allowedSessionIds)] };
}

/** Constant-time comparison without leaking length differences. */
export function secureTokenEqual(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

export function bearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(authorizationHeader.trim());
  return match?.[1]?.trim() || null;
}

export function isRemoteApiAuthorized(
  authorizationHeader: string | undefined,
  config: RemoteApiConfig = getRemoteApiConfig()
): boolean {
  const token = bearerToken(authorizationHeader);
  return Boolean(token && secureTokenEqual(token, config.apiKey));
}

/** Empty allowlists intentionally authorize nothing. A literal '*' allowlists every session. */
export function isSessionAllowlisted(
  sessionId: string,
  config: RemoteApiConfig = getRemoteApiConfig()
): boolean {
  return config.allowedSessionIds.includes('*') || config.allowedSessionIds.includes(sessionId);
}

export function normalizeRemoteSessionStatus(value: unknown): RemoteSessionStatus {
  return typeof value === 'string' && REMOTE_SESSION_STATUSES.has(value as RemoteSessionStatus)
    ? value as RemoteSessionStatus
    : 'UNAVAILABLE';
}

export function validRemoteJid(jid: string): boolean {
  return /^(?:[A-Za-z0-9._-]{1,128})@(s\.whatsapp\.net|g\.us|broadcast)$/u.test(jid);
}

export function normalizeRemoteText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  if (text.length === 0 || text.length > 4096) return null;
  return text;
}

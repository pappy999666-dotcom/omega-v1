// ============================================================
// WA-Bridge — Circuit Breaker
// Prevents cascading bans during mass outreach operations
// ============================================================

import type { CircuitState } from '../types/index.js';
import { logger } from '../utils/logger.js';

const THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD ?? '5', 10);
const RESET_MS = parseInt(process.env.CIRCUIT_BREAKER_RESET_MS ?? '3600000', 10);

// In-memory store (use Redis in multi-instance deployment)
const circuits = new Map<string, CircuitState>();

function key(telegramId: string, sessionId: string, domain = 'default'): string {
  return `${telegramId}:${sessionId}:${domain}`;
}

function getState(k: string): CircuitState {
  return circuits.get(k) ?? { state: 'closed', failures: 0, lastFailure: 0 };
}

// ── Public API ────────────────────────────────────────────

/**
 * Check if the circuit allows the operation to proceed.
 * Returns false if circuit is OPEN (rate-limited / paused).
 */
export function isCircuitOpen(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): boolean {
  const k = key(telegramId, sessionId, domain);
  const state = getState(k);

  if (state.state === 'closed') return false;

  if (state.state === 'open') {
    const elapsed = Date.now() - (state.openedAt ?? 0);
    if (elapsed >= RESET_MS) {
      // Transition to half-open — allow one probe
      circuits.set(k, { ...state, state: 'half-open' });
      logger.info(`[CircuitBreaker] ${k} → half-open (probe allowed)`);
      return false;
    }
    return true; // Still open
  }

  return false; // half-open: allow probe
}

/**
 * Record a successful operation — reset failure count.
 */
export function recordSuccess(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): void {
  const k = key(telegramId, sessionId, domain);
  const state = getState(k);
  if (state.failures > 0 || state.state !== 'closed') {
    circuits.set(k, { state: 'closed', failures: 0, lastFailure: 0 });
    logger.info(`[CircuitBreaker] ${k} → closed (success)`);
  }
}

/**
 * Record a failure. Opens the circuit after threshold is hit.
 * Returns true if circuit just tripped open.
 */
export function recordFailure(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): boolean {
  const k = key(telegramId, sessionId, domain);
  const state = getState(k);

  const failures = state.failures + 1;
  const lastFailure = Date.now();

  if (failures >= THRESHOLD) {
    circuits.set(k, {
      state: 'open',
      failures,
      lastFailure,
      openedAt: Date.now(),
    });
    logger.warn(
      `[CircuitBreaker] ${k} → OPEN after ${failures} failures. Auto-reset in ${RESET_MS / 60000}m`
    );
    return true; // Circuit just tripped
  }

  circuits.set(k, { state: 'closed', failures, lastFailure });
  return false;
}

/**
 * Manually reset a circuit (admin override).
 */
export function resetCircuit(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): void {
  const k = key(telegramId, sessionId, domain);
  circuits.delete(k);
  logger.info(`[CircuitBreaker] ${k} manually reset`);
}

/**
 * Get the time remaining until circuit auto-resets (ms).
 */
export function circuitResetIn(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): number {
  const k = key(telegramId, sessionId, domain);
  const state = getState(k);
  if (state.state !== 'open' || !state.openedAt) return 0;
  const remaining = RESET_MS - (Date.now() - state.openedAt);
  return Math.max(0, remaining);
}

export function getCircuitState(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): CircuitState {
  return getState(key(telegramId, sessionId, domain));
}

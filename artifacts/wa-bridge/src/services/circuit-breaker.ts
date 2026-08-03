// ============================================================
// WA-Bridge — Circuit Breaker
// Prevents cascading bans during mass outreach operations
// ============================================================

import type { CircuitState } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { getRedis } from './queue.js';

const THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD ?? '5', 10);
const RESET_MS = parseInt(process.env.CIRCUIT_BREAKER_RESET_MS ?? '3600000', 10);

function key(telegramId: string, sessionId: string, domain = 'default'): string {
  return `circuit:${telegramId}:${sessionId}:${domain}`;
}

async function getState(k: string): Promise<CircuitState> {
  const redis = getRedis();
  const data = await redis.get(k);
  if (!data) return { state: 'closed', failures: 0, lastFailure: 0 };
  try {
    return JSON.parse(data) as CircuitState;
  } catch {
    return { state: 'closed', failures: 0, lastFailure: 0 };
  }
}

async function saveState(k: string, state: CircuitState): Promise<void> {
  const redis = getRedis();
  await redis.set(k, JSON.stringify(state), 'PX', RESET_MS * 2);
}

// ── Public API ────────────────────────────────────────────

/**
 * Check if the circuit allows the operation to proceed.
 * Returns false if circuit is OPEN (rate-limited / paused).
 */
export async function isCircuitOpen(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): Promise<boolean> {
  const k = key(telegramId, sessionId, domain);
  const state = await getState(k);

  if (state.state === 'closed') return false;

  if (state.state === 'open') {
    const elapsed = Date.now() - (state.openedAt ?? 0);
    if (elapsed >= RESET_MS) {
      // Transition to half-open — allow one probe
      const halfOpen = { ...state, state: 'half-open' } as CircuitState;
      await saveState(k, halfOpen);
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
export async function recordSuccess(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): Promise<void> {
  const k = key(telegramId, sessionId, domain);
  const state = await getState(k);
  if (state.failures > 0 || state.state !== 'closed') {
    await getRedis().del(k);
    logger.info(`[CircuitBreaker] ${k} → closed (success)`);
  }
}

/**
 * Record a failure. Opens the circuit after threshold is hit.
 * Returns true if circuit just tripped open.
 */
export async function recordFailure(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): Promise<boolean> {
  const k = key(telegramId, sessionId, domain);
  const state = await getState(k);

  const failures = state.failures + 1;
  const lastFailure = Date.now();

  if (failures >= THRESHOLD) {
    const openState = {
      state: 'open',
      failures,
      lastFailure,
      openedAt: Date.now(),
    } as CircuitState;
    await saveState(k, openState);
    logger.warn(
      `[CircuitBreaker] ${k} → OPEN after ${failures} failures. Auto-reset in ${RESET_MS / 60000}m`
    );
    return true; // Circuit just tripped
  }

  await saveState(k, { state: 'closed', failures, lastFailure });
  return false;
}

/**
 * Manually reset a circuit (admin override).
 */
export async function resetCircuit(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): Promise<void> {
  const k = key(telegramId, sessionId, domain);
  await getRedis().del(k);
  logger.info(`[CircuitBreaker] ${k} manually reset`);
}

/**
 * Get the time remaining until circuit auto-resets (ms).
 */
export async function circuitResetIn(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): Promise<number> {
  const k = key(telegramId, sessionId, domain);
  const state = await getState(k);
  if (state.state !== 'open' || !state.openedAt) return 0;
  const remaining = RESET_MS - (Date.now() - state.openedAt);
  return Math.max(0, remaining);
}

export async function getCircuitState(
  telegramId: string,
  sessionId: string,
  domain = 'default'
): Promise<CircuitState> {
  return await getState(key(telegramId, sessionId, domain));
}

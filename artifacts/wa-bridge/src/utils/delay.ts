// ============================================================
// WA-Bridge — Jitter Delays & Exponential Backoff
// ============================================================

/**
 * Sleep for exactly `ms` milliseconds.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Jittered delay: uniform random between [minMs, maxMs].
 * Use for anti-spam evasion (allstatus, allchat, joinall).
 */
export async function jitter(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await sleep(delay);
}

/**
 * Exponential backoff with full jitter.
 * Formula: min(cap, base * 2^attempt) * random(0,1)
 */
export async function exponentialBackoff(
  attempt: number,
  baseMs = 1000,
  capMs = 60_000
): Promise<void> {
  const delay = Math.min(capMs, baseMs * Math.pow(2, attempt));
  const jittered = Math.floor(Math.random() * delay);
  await sleep(jittered);
}

/**
 * Returns a human-readable duration string.
 */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Allstatus safe delay range from environment config.
 */
export function allstatusDelay(): Promise<void> {
  const min = parseInt(process.env.ALLSTATUS_MIN_DELAY_MS ?? '4000', 10);
  const max = parseInt(process.env.ALLSTATUS_MAX_DELAY_MS ?? '9000', 10);
  return jitter(min, max);
}

/**
 * Join/Leave delay from environment config.
 */
export function joinDelay(): Promise<void> {
  const ms = parseInt(process.env.JOIN_DELAY_MS ?? '3500', 10);
  return jitter(ms, ms + 1500);
}

export function leaveDelay(): Promise<void> {
  const ms = parseInt(process.env.LEAVE_DELAY_MS ?? '2000', 10);
  return jitter(ms, ms + 1000);
}

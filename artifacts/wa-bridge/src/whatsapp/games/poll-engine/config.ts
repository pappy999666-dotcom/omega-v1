// ============================================================
// Poll Game Engine — Central Configuration
//
// Game duration and question interval are deliberately separate:
//   .wyr 5min / .quiz 5min => a five-minute game window
//   questionIntervalMs     => one new poll every 60 seconds
// ============================================================

export const POLL_GAME_CONFIG = {
  defaultGameDurationMs: 5 * 60_000,
  questionIntervalMs: 60_000,
  minimumDurationMs: 60_000,
  maximumDurationMs: 24 * 60 * 60_000,
  maximumQuestions: 24 * 60,
  aiRetryAttempts: 3,
  aiRetryBackoffMs: 250,
} as const;

export interface GameSchedule {
  gameDurationMs: number;
  questionIntervalMs: number;
  questionCount: number;
}

/** Parse a command duration without conflating it with the question interval. */
export function parseGameDuration(
  args: string[],
  defaultDurationMs = POLL_GAME_CONFIG.defaultGameDurationMs,
): number | null {
  if (!args || args.length === 0) return defaultDurationMs;

  const raw = args.join('').replace(/\s+/g, '').toLowerCase();
  const match = raw.match(/^(\d+)(ms|s|sec|m|min|h|hr|hour|hours)$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 0) return null;

  const unit = match[2];
  const multiplier = unit === 'ms'
    ? 1
    : unit === 's' || unit === 'sec'
      ? 1_000
      : unit === 'm' || unit === 'min'
        ? 60_000
        : 3_600_000;
  const durationMs = value * multiplier;
  if (
    durationMs < POLL_GAME_CONFIG.minimumDurationMs ||
    durationMs > POLL_GAME_CONFIG.maximumDurationMs
  ) return null;
  return durationMs;
}

export function scheduleForDuration(gameDurationMs: number): GameSchedule {
  const questionCount = Math.min(
    Math.max(Math.ceil(gameDurationMs / POLL_GAME_CONFIG.questionIntervalMs), 1),
    POLL_GAME_CONFIG.maximumQuestions,
  );
  return {
    gameDurationMs,
    questionIntervalMs: POLL_GAME_CONFIG.questionIntervalMs,
    questionCount,
  };
}

export function questionDurationRemaining(gameEndsAt: number, now: number): number {
  return Math.max(
    Math.min(POLL_GAME_CONFIG.questionIntervalMs, gameEndsAt - now),
    1_000,
  );
}

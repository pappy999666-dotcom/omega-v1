// ============================================================
// WA-Bridge — Levenshtein Distance for Typo Tolerance
// ============================================================

/**
 * Compute Levenshtein distance between two strings.
 * Used to match near-miss command names (single-char typos).
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] =
          1 +
          Math.min(
            dp[i - 1]![j]!,       // deletion
            dp[i]![j - 1]!,       // insertion
            dp[i - 1]![j - 1]!   // substitution
          );
      }
    }
  }

  return dp[m]![n]!;
}

/**
 * Find best matching command from a set, given a tolerance of 1 char.
 * Returns the matched command or null.
 */
export function fuzzyMatchCommand(
  input: string,
  commands: string[],
  maxDistance = 1
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;

  for (const cmd of commands) {
    const dist = levenshtein(input.toLowerCase(), cmd.toLowerCase());
    if (dist <= maxDistance && dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }

  return best;
}

/**
 * Strip extra spaces near the prefix to handle ". menu" → ".menu".
 * Also normalizes multi-space runs.
 */
export function normalizeCommandString(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

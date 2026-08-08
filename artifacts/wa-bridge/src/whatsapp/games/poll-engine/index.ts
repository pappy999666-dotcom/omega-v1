// ============================================================
// Poll Game Engine — Public Entry
// ============================================================

import { PollGameEngine, type PollEngineOptions } from './engine.js';
import { GameAI } from './ai.js';
import { wyrPlugin } from './wyr.js';
import { quizPlugin } from './quiz.js';

export * from './types.js';
export * from './engine.js';
export * from './render.js';
export { GameAI, QUIZ_CATEGORIES } from './ai.js';
export { wyrPlugin } from './wyr.js';
export { quizPlugin, computeQuizSchedule } from './quiz.js';
export {
  decryptVoteToOption,
  registerPollSecret,
  unregisterPollSecret,
  restorePollSecrets,
} from './poll-votes.js';

/**
 * Build a fully-wired engine singleton. `getConfig` resolves the
 * per-session Game API configuration (key/model) — NEVER logged.
 */
export function createPollGameEngine(options: PollEngineOptions): PollGameEngine {
  const engine = new PollGameEngine(options);
  engine.registerPlugin(wyrPlugin);
  engine.registerPlugin(quizPlugin);
  return engine;
}

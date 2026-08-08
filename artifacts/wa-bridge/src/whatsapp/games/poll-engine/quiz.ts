// ============================================================
// Poll Game Engine — Quiz
// ============================================================

import type { GameScope, PollEvent, PollGameEngineApi, PollGamePlugin, PollGameState, PollQuestion, QuizQuestionContent } from './types.js';
import { pollEventFor } from './engine.js';
import { parseGameDuration, questionDurationRemaining, scheduleForDuration } from './config.js';
import { renderQuizFinal, renderQuizHeader, renderQuizLeaderboard, renderQuizReveal } from './render.js';
import { QUIZ_CATEGORIES } from './ai.js';

export interface QuizConfig {
  gameDurationMs: number;
  questionIntervalMs: number;
  questionCount: number;
  quizBank: QuizQuestionContent[];
}

/** Kept as a public compatibility helper; it now describes the shared schedule. */
export function computeQuizSchedule(durationMs: number): { questionMs: number; questionCount: number } {
  const schedule = scheduleForDuration(durationMs);
  return { questionMs: schedule.questionIntervalMs, questionCount: schedule.questionCount };
}

export const quizPlugin: PollGamePlugin = {
  type: 'quiz',

  parseDuration(args: string[]): number | null {
    return parseGameDuration(args);
  },

  usage(prefix = '.'): string {
    return [
      '𝗤𝗨𝗜𝗭 𝗚𝗔𝗠𝗘', '',
      `Usage: ${prefix}quiz [game-duration]`, '',
      `✦ ${prefix}quiz — default 5min game`,
      `✦ ${prefix}quiz 5min — new AI question every 60s`,
      `✦ ${prefix}quiz 10min`,
      `✦ ${prefix}quiz 1hr`, '',
      'Game duration and question interval are separate. The final ranking is sent after the game window closes.',
    ].join('\n');
  },

  async start(engine: PollGameEngineApi, scope: GameScope, game: PollGameState, durationMs: number, now: number): Promise<PollEvent | undefined> {
    const schedule = scheduleForDuration(durationMs);
    // Request a bounded bank; the scheduler will never create more polls than
    // the bank contains, and the explicit cap keeps long games from producing
    // oversized/unreliable single AI responses.
    const bank = await engine.ai.generateQuiz(scope.sessionId, Math.min(schedule.questionCount, 24), QUIZ_CATEGORIES);
    engine.ai.cacheQuiz(game.id, bank);
    game.configuration = {
      gameDurationMs: durationMs,
      questionIntervalMs: schedule.questionIntervalMs,
      questionCount: schedule.questionCount,
      quizBank: bank,
    } as unknown as Record<string, unknown>;

    const first = bank[0];
    if (!first) throw new Error('No quiz questions were generated.');
    const question = engine.createQuestion(scope, game, first.question, first.options, {
      durationMs: questionDurationRemaining(game.endsAt, now),
      correctIndex: first.correctIndex,
      explanation: first.explanation,
      category: first.category,
      difficulty: first.difficulty,
    });
    return pollEventFor(game, question, renderQuizHeader(game, question, now, bank.length));
  },

  async onQuestionExpired(engine: PollGameEngineApi, game: PollGameState, question: PollQuestion, now: number): Promise<PollEvent[]> {
    const config = game.configuration as unknown as QuizConfig;
    const bank = config.quizBank ?? engine.ai.getCachedQuiz(game.id) ?? [];
    const correctVoters: string[] = [];

    for (const [voter, optionIndex] of Object.entries(question.votes)) {
      const player = game.players[voter];
      if (player && optionIndex === question.correctIndex) {
        player.score += 1;
        correctVoters.push(voter);
      }
    }

    const reveal: PollEvent = {
      scope: game.scope, gameType: game.type, gameId: game.id, questionId: question.id,
      text: renderQuizReveal(game, question, correctVoters, now), mentions: correctVoters,
    };
    const leaderboard = renderQuizLeaderboard(game);
    const leaderboardText: PollEvent = {
      scope: game.scope, gameType: game.type, gameId: game.id, questionId: question.id,
      text: leaderboard.text, mentions: leaderboard.mentions,
    };

    if (now < game.endsAt) {
      // Use the pre-generated bank first. Long games continue with bounded
      // one-question requests instead of truncating the configured game or
      // attempting an oversized single AI response.
      const content = bank[game.questions.length] ?? (await engine.ai.generateQuiz(game.scope.sessionId, 1, QUIZ_CATEGORIES))[0];
      if (!content) throw new Error('Game AI returned no next quiz question.');
      const next = engine.createQuestion(game.scope, game, content.question, content.options, {
        durationMs: questionDurationRemaining(game.endsAt, now),
        correctIndex: content.correctIndex,
        explanation: content.explanation,
        category: content.category,
        difficulty: content.difficulty,
      });
      return [
        reveal,
        leaderboardText,
        {
          scope: game.scope, gameType: game.type, gameId: game.id, questionId: question.id,
          text: leaderboard.fallback, nativeTable: leaderboard.table, tableFallbackText: leaderboard.fallback,
        },
        pollEventFor(game, next, renderQuizHeader(game, next, now, bank.length)),
      ];
    }

    const final = renderQuizFinal(game);
    await engine.finishGame(game);
    return [
      reveal,
      leaderboardText,
      {
        scope: game.scope, gameType: game.type, gameId: game.id, questionId: question.id,
        text: final.text, mentions: final.mentions,
      },
      {
        scope: game.scope, gameType: game.type, gameId: game.id, questionId: question.id,
        text: final.fallback, nativeTable: final.table, tableFallbackText: final.fallback,
      },
    ];
  },

  renderPollHeader(game: PollGameState, question: PollQuestion, now: number): string {
    const config = game.configuration as unknown as QuizConfig;
    return renderQuizHeader(game, question, now, config.quizBank?.length ?? game.schedule.questionCount);
  },
};

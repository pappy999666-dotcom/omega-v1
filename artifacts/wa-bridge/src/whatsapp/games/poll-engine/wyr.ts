// ============================================================
// Poll Game Engine — Would You Rather
// ============================================================

import type { GameScope, PollEvent, PollGameEngineApi, PollGamePlugin, PollGameState, PollQuestion } from './types.js';
import { pollEventFor } from './engine.js';
import { parseGameDuration, questionDurationRemaining } from './config.js';
import { renderWyrFinal, renderWyrHeader, renderWyrResult } from './render.js';

export const wyrPlugin: PollGamePlugin = {
  type: 'wyr',

  parseDuration(args: string[]): number | null {
    return parseGameDuration(args);
  },

  usage(prefix = '.'): string {
    return [
      '𝗪𝗢𝗨𝗟𝗗 𝗬𝗢𝗨 𝗥𝗔𝗧𝗛𝗘𝗥', '',
      `Usage: ${prefix}wyr [game-duration]`, '',
      `✦ ${prefix}wyr — default 5min game`,
      `✦ ${prefix}wyr 5min — new AI WYR every 60s`,
      `✦ ${prefix}wyr 10min`,
      `✦ ${prefix}wyr 30min`,
      `✦ ${prefix}wyr 1hr`, '',
      'Game duration and question interval are separate. Each poll closes after the next interval or when the game ends.',
    ].join('\n');
  },

  async start(engine: PollGameEngineApi, scope: GameScope, game: PollGameState, durationMs: number, now: number): Promise<PollEvent | undefined> {
    const content = await engine.ai.generateWyr(scope.sessionId);
    const question = engine.createQuestion(scope, game, content.question, [content.optionA, content.optionB], {
      durationMs: questionDurationRemaining(game.endsAt, now),
    });
    return pollEventFor(game, question, renderWyrHeader(question, now));
  },

  async onQuestionExpired(engine: PollGameEngineApi, game: PollGameState, question: PollQuestion, now: number): Promise<PollEvent[]> {
    const result = renderWyrResult(game, question);
    // Recompute aggregate participation from all closed/open questions so a
    // vote changed or removed on an earlier poll is represented exactly once.
    game.players = {};
    for (const item of game.questions) {
      for (const voter of Object.keys(item.votes)) {
        game.players[voter] ??= { jid: voter, score: 0 };
        game.players[voter]!.score += 1;
      }
    }
    const events: PollEvent[] = [
      {
        scope: game.scope, gameType: game.type, gameId: game.id, questionId: question.id,
        text: result.text, mentions: result.mentions,
      },
    ];

    if (now < game.endsAt) {
      const content = await engine.ai.generateWyr(game.scope.sessionId);
      const next = engine.createQuestion(game.scope, game, content.question, [content.optionA, content.optionB], {
        durationMs: questionDurationRemaining(game.endsAt, now),
      });
      events.push(pollEventFor(game, next, renderWyrHeader(next, now)));
      return events;
    }

    const final = renderWyrFinal(game);
    // Send the per-question choice table and the aggregate participation
    // ranking separately; clients that support native tables get both.
    events.push({
      scope: game.scope, gameType: game.type, gameId: game.id, questionId: question.id,
      text: result.fallback, nativeTable: result.table, tableFallbackText: result.fallback,
      mentions: result.mentions,
    });
    events.push({
      scope: game.scope, gameType: game.type, gameId: game.id, questionId: question.id,
      text: [result.text, '', '✅ Game duration complete. No more WYR polls will be generated.', '', final.text].join('\n'),
      nativeTable: final.table,
      tableFallbackText: final.fallback,
      mentions: final.mentions,
    });
    await engine.finishGame(game);
    return events;
  },

  renderPollHeader(_game: PollGameState, question: PollQuestion, now: number): string {
    return renderWyrHeader(question, now);
  },
};

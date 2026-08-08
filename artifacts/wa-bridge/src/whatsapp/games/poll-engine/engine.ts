// ============================================================
// Poll Game Engine — Core
//
// One centralized engine for ALL poll-based games (WYR, Quiz, and
// any future game that registers a PollGamePlugin). Responsibilities:
//
//   • Game creation & per-scope isolation (sessionId + chatJid)
//   • Question lifecycle (create → open → expire → closed)
//   • Native timed polls (endDate) + app-level freeze timers
//   • Vote ingestion with cryptographic decryption + full validation
//   • Score computation (quiz) & native-table rankings
//   • Timer cleanup, secret registry cleanup, memory hygiene
//   • Snapshot persistence + restore (survives bot restarts)
//
// Vote security rules enforced in handleVote():
//   • Unknown poll message ids are ignored (cross-game/cross-question)
//   • Votes for a closed/expired question are ignored
//   • Ambiguous/undecryptable votes are logged and dropped — never guessed
//   • A vote from another group never matches (scope check)
//   • Single-select polls: the latest vote wins (WhatsApp semantics)
// ============================================================

import crypto from 'crypto';
import type {
  GameScope,
  PollEvent,
  PollEventHandler,
  PollGamePlugin,
  PollGameSnapshot,
  PollGameState,
  PollGameType,
  PollQuestion,
  PollVoteInput,
} from './types.js';
import type { GameAI } from './ai.js';
import { questionDurationRemaining, scheduleForDuration } from './config.js';
import {
  decryptVoteToOption,
  registerPollSecret,
  restorePollSecrets,
  unregisterPollSecret,
} from './poll-votes.js';
import { logger } from '../../../utils/logger.js';

type Timer = ReturnType<typeof setTimeout>;

function scopeKey(scope: GameScope): string {
  return `${scope.sessionId}:${scope.chatJid}`;
}

function gameKey(scope: GameScope, type: PollGameType): string {
  return `${scopeKey(scope)}:${type}`;
}

function normalizeJid(jid: string): string {
  return jid.trim().toLowerCase().replace(/:\d+(?=@)/, '');
}

export interface PollEngineOptions {
  ai: GameAI;
  now?: () => number;
  /** Default event handler used when a game is started without an explicit one. */
  onEvent?: PollEventHandler;
  /** Called after every state change with a JSON-safe snapshot (persistence hook). */
  persist?: (snapshot: PollGameSnapshot) => void;
}

/** Build the PollEvent payload for a question (native timed poll + decryption key). */
export function pollEventFor(
  game: PollGameState,
  question: PollQuestion,
  headerText: string
): PollEvent {
  return {
    scope: game.scope,
    gameType: game.type,
    gameId: game.id,
    questionId: question.id,
    text: headerText,
    poll: {
      name: question.prompt,
      values: question.options,
      selectableCount: 1,
      endDate: new Date(question.expiresAt),
      messageSecret: Buffer.from(question.messageSecret ?? '', 'base64'),
    },
  };
}

/** Stable rank medallions for leaderboards. */
export const RANK_MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** @123456 token for a real JID (mention tokens are synced by the central engine). */
export function mentionToken(jid: string): string {
  const digits = (jid.split('@')[0] ?? '').replace(/\D/g, '');
  return digits ? `@${digits}` : '@user';
}

export class PollGameEngine {
  private readonly games = new Map<string, PollGameState>();
  private readonly timers = new Map<string, Timer>();
  /** Per-game event handler — set at start(), used for all later expiry events. */
  private readonly handlers = new Map<string, PollEventHandler>();
  private readonly plugins = new Map<PollGameType, PollGamePlugin>();
  private readonly ai: GameAI;
  private readonly now: () => number;
  private readonly defaultOnEvent?: PollEventHandler;
  private readonly persist?: (snapshot: PollGameSnapshot) => void;
  private sequence = 0;

  public constructor(options: PollEngineOptions) {
    this.ai = options.ai;
    this.now = options.now ?? Date.now;
    this.defaultOnEvent = options.onEvent;
    this.persist = options.persist;
  }

  public registerPlugin(plugin: PollGamePlugin): void {
    this.plugins.set(plugin.type, plugin);
  }

  // ── Introspection ────────────────────────────────────────

  public hasActive(scope: GameScope, type?: PollGameType): boolean {
    if (type) return this.games.has(gameKey(scope, type));
    for (const game of this.games.values()) {
      if (game.scope.sessionId === scope.sessionId && game.scope.chatJid === scope.chatJid) return true;
    }
    return false;
  }

  public activeCount(): number {
    return this.games.size;
  }

  /** Stop one game in exactly one session/chat scope. */
  public stop(scope: GameScope, type: PollGameType): boolean {
    const game = this.games.get(gameKey(scope, type));
    if (!game) return false;
    this.cleanupGame(game);
    return true;
  }

  public getGame(scope: GameScope, type: PollGameType): PollGameState | undefined {
    return this.games.get(gameKey(scope, type));
  }

  // ── Game start ───────────────────────────────────────────

  /**
   * Start a game of the given type. Returns the initial events to emit
   * (a usage/error event when the args are invalid, otherwise the first
   * question's poll event). The engine also emits them through the event
   * handler when one is configured.
   */
  public async start(
    scope: GameScope,
    type: PollGameType,
    args: string[],
    opts?: { onEvent?: PollEventHandler }
  ): Promise<PollEvent[]> {
    const plugin = this.plugins.get(type);
    if (!plugin) {
      const usageEvent: PollEvent = { scope, gameType: type, gameId: '', text: `⚠️ Unknown game type: ${type}.` };
      await this.emitFor(usageEvent, opts?.onEvent);
      return [usageEvent];
    }
    const durationMs = plugin.parseDuration(args, this.now());
    if (durationMs === null) {
      const usageEvent: PollEvent = { scope, gameType: type, gameId: '', text: plugin.usage() };
      await this.emitFor(usageEvent, opts?.onEvent);
      return [usageEvent];
    }
    if (this.hasActive(scope, type)) {
      const existing = this.getGame(scope, type)!;
      const activeEvent: PollEvent = {
        scope,
        gameType: type,
        gameId: existing.id,
        text: `⚠️ A ${type.toUpperCase()} game is already active in this chat. Wait for it to finish first.`,
      };
      await this.emitFor(activeEvent, opts?.onEvent);
      return [activeEvent];
    }

    const createdAt = this.now();
    const game: PollGameState = {
      id: this.createId(type),
      type,
      scope,
      status: 'active',
      createdAt,
      endsAt: createdAt + durationMs,
      schedule: scheduleForDuration(durationMs),
      players: {},
      questions: [],
      currentQuestion: 0,
      configuration: { gameDurationMs: durationMs },
    };
    this.games.set(gameKey(scope, type), game);
    if (opts?.onEvent) this.handlers.set(gameKey(scope, type), opts.onEvent);

    const api = this.makeApi(game, opts?.onEvent);
    const events: PollEvent[] = [];
    try {
      const first = await plugin.start(api, scope, game, durationMs, this.now());
      if (first) {
        events.push(first);
        await this.emitFor(first, opts?.onEvent);
      }
    } catch (err) {
      // AI not configured / generation failed — never silently fail.
      const message = err instanceof Error ? err.message : String(err);
      // Log the exact failure so the app log always shows why a game could
      // not start (the card text alone is only visible in WhatsApp).
      logger.warn('[PollGame] game start failed', { type, scope, err: message.slice(0, 300) });
      const errorEvent: PollEvent = {
        scope,
        gameType: type,
        gameId: game.id,
        text: `❌ ${type.toUpperCase()} could not start.\n\n${message.slice(0, 300)}`,
      };
      this.cleanupGame(game);
      await this.emitFor(errorEvent, opts?.onEvent);
      events.push(errorEvent);
    }
    return events;
  }

  // ── Vote ingestion (from pollUpdateMessage) ──────────────

  public async handleVote(input: PollVoteInput): Promise<void> {
    const { scope, pollMsgId } = input;
    if (!pollMsgId) return;

    // Find the game + question that owns this poll. A vote from another
    // poll / another group can never match here (games are scope-keyed and
    // questions are matched by their exact poll message id).
    let owner: { game: PollGameState; question: PollQuestion } | null = null;
    for (const game of this.games.values()) {
      if (game.scope.sessionId !== scope.sessionId || game.scope.chatJid !== scope.chatJid) continue;
      if (game.status !== 'active') continue;
      const question = game.questions.find((q) => {
        const binding = q.pollBinding;
        if (binding && (
          binding.sessionId !== scope.sessionId
          || binding.chatJid !== scope.chatJid
          || binding.gameId !== game.id
          || binding.questionId !== q.id
        )) return false;
        const boundId = binding?.pollMessageKey?.id ?? q.pollMsgId;
        return boundId === pollMsgId;
      });
      if (question) {
        owner = { game, question };
        break;
      }
    }
    if (!owner) {
      logger.debug('[PollGame] vote for unknown poll ignored', { pollMsgId, scope });
      return;
    }

    const { game, question } = owner;
    // Freeze window: expired / closed questions never accept votes.
    if (question.status !== 'open' || this.now() > question.expiresAt) {
      logger.debug('[PollGame] late vote ignored', { pollMsgId });
      return;
    }

    const voter = normalizeJid(input.voterJid);
    if (!voter || !voter.includes('@')) return;

    // Decrypt with the RAW voter JID (the fork's HMAC sign + GCM AAD use
    // the exact key-author bytes, so any stripping would break decryption).
    // The normalized form is used only for player/score bookkeeping.
    const decrypted = input.decrypted ?? await decryptVoteToOption({ ...input, voterJid: input.voterJid }, question.options);
    if (decrypted.removed) {
      // A removal only changes this question. Keep scores earned on prior
      // closed quiz questions and let the plugin recompute participation/
      // correctness from authoritative per-question votes.
      delete question.votes[voter];
      this.recomputePlayers(game);
      logger.info('[PollGame] vote removed', {
        sessionId: scope.sessionId,
        chatJid: scope.chatJid,
        gameId: game.id,
        questionId: question.id,
        pollMsgId,
        participant: voter,
      });
      this.persistSnapshot(game);
      return;
    }
    if (decrypted.optionIndex < 0) {
      // Never guess: ambiguous/undecryptable votes are safely ignored.
      logger.warn('[PollGame] ambiguous vote ignored', { pollMsgId, voter });
      return;
    }

    // Single-select poll: latest cryptographically verified vote wins.
    const previous = question.votes[voter];
    question.votes[voter] = decrypted.optionIndex;
    this.recomputePlayers(game);
    logger.info('[PollGame] vote confirmed', {
      sessionId: scope.sessionId,
      chatJid: scope.chatJid,
      gameId: game.id,
      questionId: question.id,
      pollMsgId,
      participant: voter,
      selectedOption: decrypted.optionIndex,
      changed: previous !== undefined && previous !== decrypted.optionIndex,
    });
    this.persistSnapshot(game);
  }

  // ── Poll key attachment ─────────────────────────────────

  /**
   * Bind the real WhatsApp message key of a sent poll to its question and
   * register the decryption secret. Called by the send layer after the
   * poll message key comes back from Baileys.
   */
  public attachPollKey(
    scope: GameScope,
    gameId: string,
    questionId: string,
    key: unknown
  ): void {
    const rawId = typeof key === 'object' && key !== null && 'id' in (key as Record<string, unknown>)
      ? String((key as { id: unknown }).id)
      : key
        ? String(key)
        : '';
    if (!rawId) return;
    for (const game of this.games.values()) {
      if (game.id !== gameId || game.scope.sessionId !== scope.sessionId || game.scope.chatJid !== scope.chatJid) continue;
      const question = game.questions.find((q) => q.id === questionId);
      if (!question) return;
      question.pollMsgId = rawId;
      const keyRecord = key && typeof key === 'object' ? key as Record<string, unknown> : {};
      question.pollMessageKey = {
        id: rawId,
        ...(typeof keyRecord.remoteJid === 'string' ? { remoteJid: keyRecord.remoteJid } : {}),
        ...(typeof keyRecord.fromMe === 'boolean' ? { fromMe: keyRecord.fromMe } : {}),
        ...(typeof keyRecord.participant === 'string' ? { participant: keyRecord.participant } : {}),
        ...(typeof keyRecord.participantAlt === 'string' ? { participantAlt: keyRecord.participantAlt } : {}),
        ...(typeof keyRecord.remoteJidAlt === 'string' ? { remoteJidAlt: keyRecord.remoteJidAlt } : {}),
      };
      question.pollBinding = {
        sessionId: game.scope.sessionId,
        chatJid: game.scope.chatJid,
        gameId: game.id,
        questionId: question.id,
        pollMessageKey: question.pollMessageKey,
        pollCreationTimestamp: question.pollCreationTimestamp,
        options: [...question.options],
        ...(question.correctIndex !== undefined ? { correctOption: question.correctIndex } : {}),
        expiresAt: question.expiresAt,
      };
      if (question.messageSecret) {
        registerPollSecret(rawId, Buffer.from(question.messageSecret, 'base64'), game.scope);
      }
      logger.info('[PollGame] poll created', {
        sessionId: game.scope.sessionId,
        chatJid: game.scope.chatJid,
        gameId: game.id,
        questionId: question.id,
        pollMsgId: rawId,
        pollCreationTimestamp: question.pollCreationTimestamp,
        expiresAt: question.expiresAt,
      });
      this.persistSnapshot(game);
      return;
    }
  }

  // ── Test / operational hooks ─────────────────────────────

  /** Force-expire every open question of the given scope (deterministic tests). */
  public async expireNow(scope: GameScope): Promise<void> {
    const pending: Array<{ game: PollGameState; question: PollQuestion }> = [];
    for (const game of this.games.values()) {
      if (game.scope.sessionId !== scope.sessionId || game.scope.chatJid !== scope.chatJid) continue;
      for (const q of game.questions) {
        if (q.status === 'open') pending.push({ game, question: q });
      }
    }
    for (const entry of pending) {
      const tKey = this.timerKey(scope, entry.game.id, entry.question.id);
      const timer = this.timers.get(tKey);
      if (timer) clearTimeout(timer);
      this.timers.delete(tKey);
      await this.onQuestionExpired(scope, entry.question);
    }
  }

  public disposeSession(sessionId: string): void {
    for (const game of [...this.games.values()]) {
      if (game.scope.sessionId === sessionId) this.cleanupGame(game);
    }
  }

  public dispose(): void {
    for (const game of [...this.games.values()]) this.cleanupGame(game);
    this.games.clear();
  }

  // ── Persistence ──────────────────────────────────────────

  /** JSON-safe snapshot of every active game in a scope (used at boot). */
  public snapshotsFor(scope: GameScope): PollGameSnapshot[] {
    const out: PollGameSnapshot[] = [];
    for (const game of this.games.values()) {
      if (game.scope.sessionId !== scope.sessionId || game.scope.chatJid !== scope.chatJid) continue;
      out.push(this.snapshotOf(game));
    }
    return out;
  }

  /** Restore a previously saved snapshot: re-register secrets + re-arm timers. */
  public restore(snapshot: PollGameSnapshot, onEvent?: PollEventHandler): void {
    if (!snapshot || snapshot.status !== 'active' || !snapshot.scope?.sessionId || !snapshot.scope?.chatJid) return;
    if (this.games.has(gameKey(snapshot.scope, snapshot.type))) return;
    // Re-register poll decryption secrets so late/queued votes still decrypt.
    restorePollSecrets(
      snapshot.questions
        .filter((q) => q.pollMsgId && q.messageSecret)
        .map((q) => ({ pollMsgId: q.pollMsgId!, secretB64: q.messageSecret!, scope: snapshot.scope }))
    );
    const game = snapshot as PollGameState;
    // Migrate snapshots created before explicit poll audit metadata existed.
    // Restores must preserve the original expiry and never invent a binding.
    for (const question of game.questions ?? []) {
      question.pollCreationTimestamp ??= question.createdAt;
      if (question.pollMsgId && !question.pollBinding) {
        question.pollBinding = {
          sessionId: game.scope.sessionId,
          chatJid: game.scope.chatJid,
          gameId: game.id,
          questionId: question.id,
          ...(question.pollMessageKey ? { pollMessageKey: question.pollMessageKey } : {}),
          pollCreationTimestamp: question.pollCreationTimestamp,
          options: [...question.options],
          ...(question.correctIndex !== undefined ? { correctOption: question.correctIndex } : {}),
          expiresAt: question.expiresAt,
        };
      }
    }
    // Migrate snapshots created before the centralized schedule field existed.
    // Restores must never create a second scheduler or lose the original end.
    if (!game.schedule) {
      game.schedule = scheduleForDuration(Math.max(game.endsAt - game.createdAt, 1_000));
    }
    this.games.set(gameKey(game.scope, game.type), game);
    if (onEvent) this.handlers.set(gameKey(game.scope, game.type), onEvent);
    // Re-arm timers for still-open questions. Questions whose polls ended long
    // before boot are closed SILENTLY (never re-emitted — a results card for an
    // 8-minute-old poll is spam, and the boot-time send can hang on a socket
    // that is still connecting, which previously left zombie active games).
    const now = this.now();
    const STALE_MS = 5 * 60_000;
    let anyLive = false;
    let orphanedCount = 0;
    for (const q of game.questions) {
      if (q.status !== 'open') continue;
      // A crash can occur after question creation but before Baileys returns
      // the poll message key. Such a question cannot receive an associated
      // vote after restart, so never leave it as an active zombie poll.
      if (!q.pollMsgId) {
        q.status = 'closed';
        orphanedCount += 1;
        continue;
      }
      if (q.expiresAt > now) {
        anyLive = true;
        this.scheduleExpiry(game.scope, game, q, now);
      } else if (now - q.expiresAt > STALE_MS) {
        // Ancient poll — close quietly, never re-emit.
        q.status = 'closed';
      } else {
        // Recently expired — close and let the normal expiry flow finish or
        // advance the game (sends are protected by the send-layer timeout).
        anyLive = true;
        q.status = 'closed';
        void this.onQuestionExpired(game.scope, q);
      }
    }
    if (!anyLive) {
      // Nothing left to play — finish so no zombie game survives a restart
      // (this also persists the finished state, clearing the snapshot).
      void this.finishGame(game);
    } else {
      this.persistSnapshot(game);
    }
    if (orphanedCount > 0) {
      const handler = onEvent ?? this.defaultOnEvent;
      if (handler) {
        void Promise.resolve(handler({
          scope: game.scope,
          gameType: game.type,
          gameId: game.id,
          text: `⚠️ ${game.type.toUpperCase()} resumed after restart, but ${orphanedCount} poll${orphanedCount === 1 ? '' : 's'} could not be recovered because WhatsApp did not return a message key. Those poll${orphanedCount === 1 ? '' : 's'} were closed safely.`,
        })).catch((err: unknown) => logger.warn('[PollGame] orphan recovery notice failed', { err: String(err) }));
      }
    }
    logger.info('[PollGame] restored game', {
      gameId: game.id,
      type: game.type,
      scope: game.scope,
      questions: game.questions.length,
      live: anyLive,
    });
  }

  // ── Internals ────────────────────────────────────────────

  private createId(type: string): string {
    this.sequence += 1;
    return `${type}-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  private timerKey(scope: GameScope, gameId: string, questionId: string): string {
    return `${scopeKey(scope)}:${gameId}:${questionId}`;
  }

  private makeApi(
    game: PollGameState,
    onEvent?: PollEventHandler
  ): {
    ai: GameAI;
    createQuestion: (
      scope: GameScope,
      g: PollGameState,
      prompt: string,
      options: string[],
      extra: Partial<PollQuestion> & { durationMs: number }
    ) => PollQuestion;
    scheduleExpiry: (scope: GameScope, g: PollGameState, q: PollQuestion, now: number) => void;
    finishGame: (g: PollGameState) => Promise<void>;
    emit: (event: PollEvent) => Promise<{ key?: unknown } | void>;
  } {
    return {
      ai: this.ai,
      createQuestion: (scope, g, prompt, options, extra) => this.createQuestion(scope, g, prompt, options, extra),
      scheduleExpiry: (scope, g, q, now) => this.scheduleExpiry(scope, g, q, now),
      finishGame: (g) => this.finishGame(g),
      emit: (event) => this.emitFor(event, onEvent),
    };
  }

  /** Create a question, add it to the game, arm its expiry timer. */
  private createQuestion(
    scope: GameScope,
    game: PollGameState,
    prompt: string,
    options: string[],
    extra: Partial<PollQuestion> & { durationMs: number }
  ): PollQuestion {
    const id = `q${game.questions.length}`;
    const secret = crypto.randomBytes(32);
    const createdAt = this.now();
    const question: PollQuestion = {
      id,
      prompt,
      options,
      messageSecret: secret.toString('base64'),
      createdAt,
      expiresAt: Math.min(
        createdAt + Math.max(extra.durationMs, 1_000),
        game.endsAt,
      ),
      status: 'open',
      pollCreationTimestamp: createdAt,
      votes: {},
    };
    if (extra.correctIndex !== undefined) question.correctIndex = extra.correctIndex;
    if (extra.explanation) question.explanation = extra.explanation;
    if (extra.category) question.category = extra.category;
    if (extra.difficulty) question.difficulty = extra.difficulty;
    game.questions.push(question);
    // Persist before the network send. A process crash between poll creation
    // and message-key attachment must not lose the active game definition.
    this.persistSnapshot(game);
    this.scheduleExpiry(scope, game, question, createdAt);
    return question;
  }

  private scheduleExpiry(scope: GameScope, game: PollGameState, question: PollQuestion, now: number): void {
    const tKey = this.timerKey(scope, game.id, question.id);
    const existing = this.timers.get(tKey);
    if (existing) clearTimeout(existing);
    const delay = Math.max(question.expiresAt - now, 0);
    const timer = setTimeout(() => {
      this.timers.delete(tKey);
      void this.onQuestionExpired(scope, question);
    }, delay);
    this.timers.set(tKey, timer);
  }

  /** Freeze the question, let the plugin score/reveal/advance. */
  private async onQuestionExpired(scope: GameScope, question: PollQuestion): Promise<void> {
    const owner = this.findOwner(scope, question.id);
    if (!owner) return;
    const { game: g, question: q } = owner;
    if (g.status !== 'active' || q.status !== 'open') return;
    q.status = 'closed'; // freeze — late votes are now ignored
    const plugin = this.plugins.get(g.type);
    if (!plugin) {
      await this.finishGame(g);
      return;
    }
    const api = this.makeApi(g);
    const handler = this.handlers.get(gameKey(g.scope, g.type));
    try {
      const events = await plugin.onQuestionExpired(api, g, q, this.now());
      for (const ev of events) {
        await this.emitFor(ev, handler);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[PollGame] question expiry handler failed', {
        gameId: g.id,
        question: q.id,
        err: message.slice(0, 300),
      });
      await this.emitFor({
        scope: g.scope,
        gameType: g.type,
        gameId: g.id,
        questionId: q.id,
        text: `❌ ${g.type.toUpperCase()} stopped after an AI or scheduler failure.\\n\\n${message.slice(0, 300)}`,
      }, handler);
      await this.finishGame(g);
    }
    this.persistSnapshot(g);
  }

  private findOwner(scope: GameScope, questionId: string): { game: PollGameState; question: PollQuestion } | null {
    for (const game of this.games.values()) {
      if (game.scope.sessionId !== scope.sessionId || game.scope.chatJid !== scope.chatJid) continue;
      const q = game.questions.find((qq) => qq.id === questionId);
      if (q) return { game, question: q };
    }
    return null;
  }

private async emitFor(
    event: PollEvent,
    perCall?: PollEventHandler
  ): Promise<{ key?: unknown; sent?: boolean } | void> {
    const handler = perCall ?? this.defaultOnEvent;
    if (!handler) return;
    try {
      const result = await handler(event);
      // A real send handler reports sent:false when Baileys rejected or timed
      // out. Stop this game rather than allowing an unbound scheduler to run.
      if (event.poll && result?.sent === false) {
        const game = this.getGame(event.scope, event.gameType);
        if (game) {
          this.cleanupGame(game);
          await handler({
            scope: event.scope,
            gameType: event.gameType,
            gameId: event.gameId,
            text: `❌ ${event.gameType.toUpperCase()} stopped because WhatsApp rejected a poll send. Try again when the session is stable.`,
          });
        }
      }
      // Auto-attach the sent poll's message key so votes can be matched.
      if (result?.key && event.questionId && event.poll) {
        this.attachPollKey(event.scope, event.gameId, event.questionId, result.key);
      }
      return result;
    } catch (err) {
      logger.warn('[PollGame] event emission failed', {
        gameId: event.gameId,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  /** Cleanup-only: clears timers, unregisters secrets, removes state. Never emits. */
  private async finishGame(game: PollGameState): Promise<void> {
    this.cleanupGame(game);
  }

  /** Rebuild players from authoritative votes; never infer participation elsewhere. */
  private recomputePlayers(game: PollGameState): void {
    const previousScores = new Map(Object.entries(game.players).map(([jid, player]) => [jid, player.score]));
    game.players = {};
    for (const question of game.questions) {
      for (const voter of Object.keys(question.votes)) {
        game.players[voter] ??= { jid: voter, score: previousScores.get(voter) ?? 0 };
      }
    }
  }

  private cleanupGame(game: PollGameState): void {
    if (game.status === 'active') game.status = 'finished';
    for (const q of game.questions) {
      const tKey = this.timerKey(game.scope, game.id, q.id);
      const timer = this.timers.get(tKey);
      if (timer) clearTimeout(timer);
      this.timers.delete(tKey);
    if (q.pollMsgId) unregisterPollSecret(q.pollMsgId, game.scope);
  }
  this.ai.clearCache(game.id);
  this.games.delete(gameKey(game.scope, game.type));
  this.handlers.delete(gameKey(game.scope, game.type));
  this.persistSnapshot(game);
  }

  private snapshotOf(game: PollGameState): PollGameSnapshot {
    return {
      ...game,
      schedule: { ...game.schedule },
      timers: [], // shape parity only — timer handles are never serialized
      players: { ...game.players },
      questions: game.questions.map((q) => ({ ...q, votes: { ...q.votes } })),
      configuration: { ...game.configuration },
    };
  }

  private persistSnapshot(game: PollGameState): void {
    if (!this.persist) return;
    try {
      this.persist(this.snapshotOf(game));
    } catch (err) {
      logger.warn('[PollGame] persistence failed', { err: String(err) });
    }
  }
}

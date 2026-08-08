import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ═══════════════════════════════════════════════════════════
// Game Engine — centralized, timer-safe, session-scoped.
// WCG (Word Chain) is a full stateful turn machine; TTT is a
// two-player text-board game. Both are isolated by session+chat.
// ═══════════════════════════════════════════════════════════

export interface GameScope {
  sessionId: string;
  chatJid: string;
}

export interface GameResponse {
  scope: GameScope;
  gameType: 'wcg' | 'ttt';
  gameId: string;
  text: string;
  mentions: string[];
  /** Existing WhatsApp message key to edit when available. */
  editKey?: unknown;
}

export interface GameEventHandler {
  (response: GameResponse): Promise<void> | void;
}

export interface GameManagerOptions {
  joiningMs?: number;
  turnMs?: number;
  challengeMs?: number;
  minWordLength?: number;
  randomLetter?: () => string;
  /** RNG for the one-time lobby shuffle (spec §2). Injectable for deterministic tests. */
  randomNumber?: () => number;
  onEvent?: GameEventHandler;
}

export interface GameInput {
  scope: GameScope;
  playerJid: string;
  /** WCG/TTT command or ordinary text. */
  kind: 'wcg' | 'join' | 'ttt' | 'text';
  args?: string[];
  text?: string;
  targetJid?: string;
  canStart?: boolean;
  onEvent?: GameEventHandler;
}

type Player = { jid: string; score: number };
type Timer = ReturnType<typeof setTimeout>;

// ── Hard-mode difficulty curve ─────────────────────────────
// Round 1–2: 3 words / 30s   →  Mid: 4 words / 25s  →  Late: 5 words / 20s
const DIFFICULTY = [
  { words: 3, seconds: 30 },
  { words: 4, seconds: 25 },
  { words: 5, seconds: 20 },
] as const;

type WcgTurnPhase = 'idle' | 'answered' | 'eliminated';

type WcgSession = {
  type: 'wcg';
  id: string;
  scope: GameScope;
  players: Player[];
  active: Set<string>;
  usedWords: Set<string>;
  phase: 'joining' | 'playing';
  /** Stable turn queue — insertion order, never re-ordered or randomized. */
  queue: Player[];
  /** Index into `queue` for the CURRENT turn (always an active player). */
  queueIndex: number;
  /** Number of completed full laps of the queue. */
  round: number;
  currentLetter: string;
  currentWords: number;
  currentSeconds: number;
  /** Per-turn accepted words — cleared on every turn change. */
  turnWords: string[];
  /** Monotonic turn identifier — stale answers are ignored. */
  turnId: number;
  /** Atomic per-turn state: idle → answered | eliminated (never both). */
  turnPhase: WcgTurnPhase;
  lobbyTimer?: Timer;
  turnTimer?: Timer;
  lobbyMessageKey?: unknown;
  onEvent?: GameEventHandler;
};

type TttSession = {
  type: 'ttt';
  id: string;
  scope: GameScope;
  player1: Player;
  player2: Player;
  accepted: boolean;
  board: Array<'❌' | '⭕' | null>;
  current: 1 | 2;
  challengeTimer?: Timer;
  turnTimer?: Timer;
  boardMessageKey?: unknown;
  onEvent?: GameEventHandler;
};

type Session = WcgSession | TttSession;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

function scopeKey(scope: GameScope): string {
  return `${scope.sessionId}:${scope.chatJid}`;
}

function normalizeJid(jid: string): string {
  return jid.trim().toLowerCase().replace(/:\d+(?=@)/, '');
}

function numberOf(jid: string): string {
  return normalizeJid(jid).split('@')[0]?.replace(/\D/g, '') ?? '';
}

function token(jid: string): string {
  const digits = numberOf(jid);
  return digits ? `@${digits}` : '@user';
}

function playerMention(jid: string): string {
  return token(jid);
}

function uniqueJids(jids: string[]): string[] {
  return [...new Set(jids.map(normalizeJid).filter((jid) => jid.includes('@s.whatsapp.net')))];
}

function response(session: Session, text: string, mentions: string[] = []): GameResponse {
  const editKey = session.type === 'wcg' ? session.lobbyMessageKey : session.boardMessageKey;
  return {
    scope: session.scope,
    gameType: session.type,
    gameId: session.id,
    text,
    mentions: uniqueJids(mentions),
    ...(editKey ? { editKey } : {}),
  };
}

// ── WCG rendering ──────────────────────────────────────────

function formatWcgLobby(session: WcgSession): string {
  const players = session.players.length;
  const names = session.players.map((p) => playerMention(p.jid)).join(', ');
  return [
    '𝗪 𝗢 𝗥 𝗗  𝄜  𝗖 𝗛 𝗔 𝗜 𝗡  𝗚 𝗔 𝗠 𝗘',
    '',
    '✦ Status : Joining Period (40s)',
    `✦ Players: ${players}${names ? `\n  └─ ${names}` : ''}`,
    '',
    '✦ How to Play',
    '  └─ The bot will give you a letter.',
    '  └─ Reply with valid words using that letter.',
    '  └─ The required number of words will be shown each turn.',
    '',
    '✦ To Join',
    '  └─ Type: .join',
    '',
    '· · ────────────────────── · ·',
    'Game starts automatically when the joining period ends.',
    '· · ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ——— · ·',
  ].join('\n');
}

function currentWcgPlayer(session: WcgSession): Player {
  return session.queue[session.queueIndex]!;
}

/** Next active player in the STABLE queue (never random, never re-ordered). */
function nextActiveWcgPlayer(session: WcgSession): Player {
  const n = session.queue.length;
  for (let step = 1; step <= n; step += 1) {
    const candidate = session.queue[(session.queueIndex + step) % n]!;
    if (session.active.has(candidate.jid)) return candidate;
  }
  return session.queue[session.queueIndex]!;
}

function formatWcgTurn(session: WcgSession): string {
  const current = currentWcgPlayer(session);
  const mention = playerMention(current.jid);
  return [
    '𝗪 𝗢 𝗥 𝗗  𝄜  𝗖 𝗛 𝗔 𝗜 𝗡',
    '',
    `✦ Next Turn : ${mention}`,
    `✦ Turn      : ${mention}`,
    `✦ Letter    : ${session.currentLetter}`,
    `✦ Required  : ${session.currentWords} words`,
    `✦ Time      : ${session.currentSeconds} seconds`,
    '',
    '· · ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ——— · ·',
  ].join('\n');
}

function formatWcgMissed(session: WcgSession, reason: string): string {
  const current = currentWcgPlayer(session);
  return [
    '𝗪 𝗢 𝗥 𝗗  𝄜  𝗖 𝗛 𝗔 𝗜 𝗡',
    '',
    '❌ 𝗠 𝗜 𝗦 𝗦 𝗘 𝗗  𝗧 𝗨 𝗥 𝗡',
    '',
    `✦ Player : ${playerMention(current.jid)}`,
    `✦ Status : ${reason}`,
    '✦ Action : Player eliminated',
    '',
    '· · ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ——— · ·',
  ].join('\n');
}

function formatWcgWinner(winner: Player): string {
  return [
    '𝗪 𝗢 𝗥 𝗗  𝄜  𝗖 𝗛 𝗔 𝗜 𝗡',
    '',
    '🏆 𝗚 𝗔 𝗠 𝗘  𝗪 𝗜 𝗡 𝗡 𝗘 𝗥',
    `✦ Winner : ${playerMention(winner.jid)}`,
    '✦ Status : Victorious in Word Chain',
    '',
    '· · ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ——— · ·',
  ].join('\n');
}

// ── TTT rendering ──────────────────────────────────────────

function formatBoard(board: Array<'❌' | '⭕' | null>): string {
  const cell = (index: number): string => board[index] ?? '·';
  return [
    '   1   2   3',
    '',
    `A  ${cell(0)}   ${cell(1)}   ${cell(2)}`,
    `B  ${cell(3)}   ${cell(4)}   ${cell(5)}`,
    `C  ${cell(6)}   ${cell(7)}   ${cell(8)}`,
  ].join('\n');
}

function formatTtt(session: TttSession, footer: string): string {
  return [
    '🎮 𝗧𝗜𝗖-𝗧𝗔𝗖-𝗧𝗢𝗘',
    '',
    `❌ ${playerMention(session.player1.jid)}   ⭕ ${playerMention(session.player2.jid)}`,
    '',
    formatBoard(session.board),
    '',
    footer,
    '',
    'Move with: .ttt A1   •   Give up: .ttt giveup',
  ].join('\n');
}

function parseMove(value: string | undefined): number {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[^A-C1-3]/g, '');
  const match = normalized.match(/^([ABC])([123])$/);
  if (!match) return -1;
  return ('ABC'.indexOf(match[1]!) * 3) + Number(match[2]) - 1;
}

function winningSymbol(board: Array<'❌' | '⭕' | null>): '❌' | '⭕' | null {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

// ── Dictionary (local, no AI, loaded once) ─────────────────

function defaultDictionary(): Set<string> {
  try {
    const wordListModule = require('word-list') as { default?: string } | string;
    const file = typeof wordListModule === 'string' ? wordListModule : wordListModule.default;
    if (!file) return new Set();
    const fs = require('node:fs') as typeof import('node:fs');
    return new Set(
      fs.readFileSync(file, 'utf8')
        .split(/\r?\n/u)
        .map((word: string) => word.trim().toLowerCase())
        .filter((word: string) => /^[a-z]+$/u.test(word) && word.length > 1)
    );
  } catch {
    return new Set();
  }
}

let dictionary: Set<string> | undefined;
function isDictionaryWord(word: string): boolean {
  dictionary ??= defaultDictionary();
  return dictionary.has(word);
}

// ── Game Manager ───────────────────────────────────────────

export class GameManager {
  private readonly sessions = new Map<string, Session>();
  private readonly joiningMs: number;
  private readonly turnMs: number;
  private readonly challengeMs: number;
  private readonly minWordLength: number;
  private readonly randomLetter: () => string;
  private readonly randomNumber: () => number;
  private readonly defaultOnEvent?: GameEventHandler;
  private sequence = 0;

  public constructor(options: GameManagerOptions = {}) {
    this.joiningMs = options.joiningMs ?? 40_000;
    this.turnMs = options.turnMs ?? 30_000;
    this.challengeMs = options.challengeMs ?? 60_000;
    this.minWordLength = options.minWordLength ?? 3;
    this.randomLetter = options.randomLetter ?? (() => LETTERS[Math.floor(Math.random() * LETTERS.length)]!);
    this.randomNumber = options.randomNumber ?? Math.random;
    this.defaultOnEvent = options.onEvent;
  }

  public async handle(input: GameInput): Promise<GameResponse | undefined> {
    const playerJid = normalizeJid(input.playerJid);
    if (!playerJid) return undefined;
    const key = scopeKey(input.scope);

    if (input.kind === 'wcg') {
      if (!input.canStart || !input.scope.chatJid.endsWith('@g.us')) return undefined;
      return this.startWcg(input.scope, input.onEvent);
    }

    if (input.kind === 'join') {
      const game = this.sessions.get(key);
      if (!game || game.type !== 'wcg') return undefined;
      if (game.phase !== 'joining') return response(game, '⌛ The Word Chain joining period is closed. Wait for the next game.');
      return this.joinWcg(game, playerJid);
    }

    if (input.kind === 'text') {
      const game = this.sessions.get(key);
      if (!game || game.type !== 'wcg' || game.phase !== 'playing') return undefined;
      return await this.answerWcg(game, playerJid, input.text ?? '');
    }

    if (input.kind === 'ttt') {
      const args = input.args ?? [];
      const action = args[0]?.toLowerCase();
      const existing = this.sessions.get(key);

      if (action === 'accept' || action === 'yes') {
        if (!existing || existing.type !== 'ttt') return undefined;
        return this.acceptTtt(existing, playerJid);
      }
      if (action === 'decline' || action === 'no') {
        if (!existing || existing.type !== 'ttt') return undefined;
        return this.declineTtt(existing, playerJid);
      }
      if (action === 'giveup' || action === 'quit' || action === 'resign') {
        if (!existing || existing.type !== 'ttt') return undefined;
        return this.giveUpTtt(existing, playerJid);
      }
      if (existing?.type === 'ttt' && (parseMove(args[0]) >= 0 || action === 'move')) {
        return this.moveTtt(existing, playerJid, action === 'move' ? args[1] : args[0]);
      }
      if (!input.canStart) return undefined;
      if (!input.targetJid || !input.scope.chatJid) return this.tttUsage(input.scope);
      return this.startTtt(input.scope, playerJid, normalizeJid(input.targetJid), input.onEvent);
    }

    return undefined;
  }

  public attachMessageKey(scope: GameScope, gameType: 'wcg' | 'ttt', key: unknown): void {
    const game = this.sessions.get(scopeKey(scope));
    if (!game || game.type !== gameType) return;
    if (game.type === 'wcg') game.lobbyMessageKey = key;
    else game.boardMessageKey = key;
  }

  public activeCount(): number {
    return this.sessions.size;
  }

  public hasActive(scope: GameScope): boolean {
    return this.sessions.has(scopeKey(scope));
  }

  /** Deterministic lifecycle hooks used by focused tests and operational tooling. */
  public startNow(scope: GameScope): Promise<void> {
    const game = this.sessions.get(scopeKey(scope));
    if (game?.type === 'wcg' && game.phase === 'joining') return this.closeLobby(game);
    return Promise.resolve();
  }

  public expireNow(scope: GameScope): void {
    const game = this.sessions.get(scopeKey(scope));
    if (game?.type === 'wcg' && game.phase === 'playing') this.expireWcgTurn(game);
    if (game?.type === 'ttt' && game.accepted) this.expireTtt(game);
  }

  public dispose(): void {
    for (const game of this.sessions.values()) this.cleanup(game);
    this.sessions.clear();
  }

  public disposeSession(sessionId: string): void {
    for (const game of [...this.sessions.values()]) {
      if (game.scope.sessionId === sessionId) this.cleanup(game);
    }
  }

  private createId(type: string): string {
    this.sequence += 1;
    return `${type}-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  private schedule(game: Session, callback: () => void, delay: number): Timer {
    const timer = setTimeout(() => {
      if (this.sessions.get(scopeKey(game.scope)) !== game) return;
      callback();
    }, delay);
    return timer;
  }

  /** Fire the response handler and return its promise so callers can wait. */
  private emit(game: Session, result: GameResponse): Promise<void> {
    const handler = game.onEvent ?? this.defaultOnEvent;
    if (!handler) return Promise.resolve();
    return Promise.resolve(handler(result)).catch(() => undefined);
  }

  // ── WCG: lobby ───────────────────────────────────────────

  private startWcg(scope: GameScope, onEvent?: GameEventHandler): GameResponse {
    const key = scopeKey(scope);
    const existing = this.sessions.get(key);
    if (existing) {
      return response(existing, `⚠️ A ${existing.type.toUpperCase()} game is already active in this chat.`);
    }
    const game: WcgSession = {
      type: 'wcg',
      id: this.createId('wcg'),
      scope,
      players: [],
      active: new Set(),
      usedWords: new Set(),
      phase: 'joining',
      queue: [],
      queueIndex: 0,
      round: 0,
      currentLetter: '',
      currentWords: DIFFICULTY[0]!.words,
      currentSeconds: DIFFICULTY[0]!.seconds,
      turnWords: [],
      turnId: 0,
      turnPhase: 'idle',
      onEvent,
    };
    this.sessions.set(key, game);
    const result = response(game, formatWcgLobby(game));
    game.lobbyTimer = this.schedule(game, () => this.closeLobby(game), this.joiningMs);
    return result;
  }

  private joinWcg(game: WcgSession, playerJid: string): GameResponse {
    if (game.players.some((p) => normalizeJid(p.jid) === playerJid)) {
      return response(game, `ℹ️ ${playerMention(playerJid)} is already in this Word Chain lobby.`, [playerJid]);
    }
    const player = { jid: playerJid, score: 0 };
    game.players.push(player);
    game.queue.push(player);
    game.active.add(playerJid);
    return response(game, formatWcgLobby(game), game.players.map((p) => p.jid));
  }

  private closeLobby(game: WcgSession): Promise<void> {
    if (game.lobbyTimer) clearTimeout(game.lobbyTimer);
    game.lobbyTimer = undefined;
    if (game.players.length < 2) {
      const result = response(game, [
        '𝗪 𝗢 𝗥 𝗗  𝗖 𝗛 𝗔 𝗜 𝗡', '',
        '⚠️ Game ended',
        'Not enough players joined before the 40-second joining period ended.',
        'Minimum players required: 2.',
      ].join('\n'), game.players.map((p) => p.jid));
      const promise = this.emit(game, result);
      this.cleanup(game);
      return promise;
    }
    game.phase = 'playing';
    // Spec §2: shuffle the joined players ONCE, then freeze the queue. From here
    // on the queue is immutable except for eliminated players being skipped.
    const shuffled = [...game.players];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.randomNumber() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    game.players = shuffled;
    game.queue = shuffled;
    game.queueIndex = 0;
    game.round = 0;
    return this.beginTurn(game);
  }

  // ── WCG: turn machine ────────────────────────────────────
  // A turn only transitions once: idle → answered | eliminated.
  // Timers are ONLY armed after the notify response is emitted.

  private difficultyFor(game: WcgSession): { words: number; seconds: number } {
    const idx = Math.min(game.round, DIFFICULTY.length - 1);
    return DIFFICULTY[idx]!;
  }

  private beginTurn(game: WcgSession): Promise<void> {
    void currentWcgPlayer(game); // the queue cursor defines the current player
    game.turnId += 1;
    game.turnWords = [];
    game.turnPhase = 'idle';
    game.currentLetter = this.randomLetter().toUpperCase().slice(0, 1);
    const diff = this.difficultyFor(game);
    game.currentWords = diff.words;
    game.currentSeconds = diff.seconds;
    const mentions = game.players.map((p) => p.jid);
    const result = response(game, formatWcgTurn(game), mentions);
    // The timer starts ONLY after the turn notification is delivered.
    return this.emit(game, result).then(() => this.armWcgTurn(game));
  }

  private armWcgTurn(game: WcgSession): void {
    // The notify was delivered asynchronously; the game may have been cleaned up
    // in that window (dispose/end). Never arm a timer for a removed session.
    if (this.sessions.get(scopeKey(game.scope)) !== game) return;
    if (game.turnTimer) clearTimeout(game.turnTimer);
    game.turnTimer = this.schedule(game, () => this.expireWcgTurn(game), game.currentSeconds * 1000);
  }

  private async answerWcg(game: WcgSession, playerJid: string, rawText: string): Promise<GameResponse | undefined> {
    const current = currentWcgPlayer(game);
    // Only the current player may answer; everything else is ignored.
    if (!game.active.has(playerJid) || normalizeJid(current.jid) !== playerJid) return undefined;
    // A turn already resolved (concurrent timer/answer) must never be re-transitioned.
    if (game.turnPhase !== 'idle') return undefined;

    const rawWords = rawText.trim().split(/[\s,.;!?]+/u).filter(Boolean);
    if (rawWords.length === 0) {
      return response(game, '⚠️ Send at least one word. Example: victory village voice', [playerJid]);
    }

    const accepted: string[] = [];
    const rejected: string[] = [];
    const seenThisTurn = new Set<string>();

    for (const raw of rawWords) {
      const word = raw.toLowerCase().replace(/[^a-z]/g, '');
      if (word.length < this.minWordLength) {
        rejected.push(raw);
        continue;
      }
      if (!word.startsWith(game.currentLetter.toLowerCase())) {
        rejected.push(raw);
        continue;
      }
      if (game.usedWords.has(word) || seenThisTurn.has(word)) {
        rejected.push(raw);
        continue;
      }
      if (!isDictionaryWord(word)) {
        rejected.push(raw);
        continue;
      }
      seenThisTurn.add(word);
      game.usedWords.add(word);
      accepted.push(word);
    }

    if (game.turnWords.length + accepted.length > game.currentWords) {
      // The player overshot the required count — no completion this message.
      const extra = accepted.splice(game.currentWords - game.turnWords.length);
      rejected.push(...extra);
    }

    game.turnWords.push(...accepted);
    current.score += accepted.length;
    const need = game.currentWords;

    if (game.turnWords.length >= need) {
      // SUCCESS — atomic transition, cancel the timer, advance deterministically.
      if (game.turnTimer) clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
      const scored = game.turnWords.length;
      game.turnPhase = 'answered';
      const mention = playerMention(current.jid);
      const result = response(game, `${mention} scored ${scored} point${scored === 1 ? '' : 's'} with ${scored} word${scored === 1 ? '' : 's'}.`, [playerJid]);
      // Deliver the score confirmation BEFORE announcing the next turn, so the
      // group sees the correct order: score → next turn (elimination already
      // emits missed → next turn). advanceQueue is chained after the score
      // event is delivered and never races the caller's response.
      void this.emit(game, result).then(() => {
        if (this.sessions.get(scopeKey(game.scope)) !== game) return;
        return this.advanceQueue(game);
      });
      return undefined;
    }

    const missing = need - game.turnWords.length;
    const reply = [
      `✦ Words accepted this turn: ${game.turnWords.length}/${need}`,
      ...(accepted.length > 0 ? [`  └─ ${accepted.join(', ')}`] : []),
      ...(rejected.length > 0 ? [`  ✗ Rejected: ${rejected.join(', ')}`] : []),
      '',
      `Reply with ${missing} more valid word${missing === 1 ? '' : 's'} beginning with ${game.currentLetter}.`,
    ].join('\n');
    return response(game, reply, [playerJid]);
  }

  private advanceQueue(game: WcgSession): Promise<void> {
    const next = nextActiveWcgPlayer(game);
    if (normalizeJid(next.jid) === normalizeJid(currentWcgPlayer(game).jid)) {
      // No other active player — the current player just won.
      game.turnPhase = 'eliminated';
      const winner = currentWcgPlayer(game);
      void this.emit(game, response(game, formatWcgWinner(winner), [winner.jid]));
      this.cleanup(game);
      return Promise.resolve();
    }
    // Move the queue cursor to the next active player. Wrapping the end of
    // the stable queue means one full round has passed.
    const oldIndex = game.queueIndex;
    const targetIndex = game.queue.findIndex((p) => p.jid === next.jid);
    if (targetIndex <= oldIndex) game.round += 1;
    game.queueIndex = targetIndex;
    return this.beginTurn(game);
  }

  private expireWcgTurn(game: WcgSession): void {
    if (game.turnPhase !== 'idle') return; // timer raced a valid answer
    game.turnPhase = 'eliminated';
    if (game.turnTimer) clearTimeout(game.turnTimer);
    game.turnTimer = undefined;

    const current = currentWcgPlayer(game);
    game.active.delete(current.jid);

    const remaining = game.players.filter((p) => game.active.has(p.jid));
    const missedText = formatWcgMissed(game, 'Time expired');

    if (remaining.length <= 1) {
      const winner = remaining[0];
      const text = winner ? `${missedText}\n\n${formatWcgWinner(winner)}` : missedText;
      void this.emit(game, response(game, text, winner ? [current.jid, winner.jid] : [current.jid]));
      this.cleanup(game);
      return;
    }

    const next = this.nextActiveAfter(game);
    game.queueIndex = game.queue.findIndex((p) => p.jid === next.jid);
    void this.emit(game, response(game, missedText, [current.jid, next.jid]));
    this.beginTurn(game);
  }

  private nextActiveAfter(game: WcgSession): Player {
    const n = game.queue.length;
    for (let step = 1; step <= n; step += 1) {
      const candidate = game.queue[(game.queueIndex + step) % n]!;
      if (game.active.has(candidate.jid)) return candidate;
    }
    return game.queue[game.queueIndex]!;
  }

  // ── TTT ──────────────────────────────────────────────────

  private startTtt(scope: GameScope, player1Jid: string, player2Jid: string, onEvent?: GameEventHandler): GameResponse {
    if (player1Jid === player2Jid) {
      const fake: TttSession = {
        type: 'ttt', id: this.createId('ttt'), scope,
        player1: { jid: player1Jid, score: 0 }, player2: { jid: player2Jid, score: 0 },
        accepted: false, board: [], current: 1, onEvent,
      };
      return response(fake, '⚠️ Choose another player; you cannot challenge yourself.', [player1Jid]);
    }
    const key = scopeKey(scope);
    const existing = this.sessions.get(key);
    if (existing) return response(existing, `⚠️ A ${existing.type.toUpperCase()} game is already active in this chat.`);
    const game: TttSession = {
      type: 'ttt', id: this.createId('ttt'), scope,
      player1: { jid: player1Jid, score: 0 }, player2: { jid: player2Jid, score: 0 },
      accepted: false, board: Array(9).fill(null), current: 1, onEvent,
    };
    this.sessions.set(key, game);
    game.challengeTimer = this.schedule(game, () => {
      void this.emit(game, response(game, `⌛ Tic-Tac-Toe challenge expired for ${playerMention(game.player2.jid)}.`, [game.player1.jid, game.player2.jid]));
      this.cleanup(game);
    }, this.challengeMs);
    return response(game, `🎮 𝗧𝗜𝗖-𝗧𝗔𝗖-𝗧𝗢𝗘\n\n${playerMention(player1Jid)} challenged ${playerMention(player2Jid)}.\n\n${playerMention(player2Jid)}, accept with .ttt accept or decline with .ttt decline.`, [player1Jid, player2Jid]);
  }

  private acceptTtt(game: TttSession, playerJid: string): GameResponse | undefined {
    if (game.accepted || playerJid !== normalizeJid(game.player2.jid)) return undefined;
    game.accepted = true;
    if (game.challengeTimer) clearTimeout(game.challengeTimer);
    game.turnTimer = this.schedule(game, () => this.expireTtt(game), this.turnMs);
    const result = response(game, formatTtt(game, `Turn: ${playerMention(game.player1.jid)} ❌`), [game.player1.jid, game.player2.jid]);
    return result;
  }

  private declineTtt(game: TttSession, playerJid: string): GameResponse | undefined {
    if (game.accepted || playerJid !== normalizeJid(game.player2.jid)) return undefined;
    const result = response(game, `❌ ${playerMention(playerJid)} declined the Tic-Tac-Toe challenge.`, [game.player1.jid, game.player2.jid]);
    this.cleanup(game);
    return result;
  }

  private moveTtt(game: TttSession, playerJid: string, rawMove: string | undefined): GameResponse | undefined {
    if (!game.accepted) return response(game, '⌛ The challenged player must accept before moves can begin.');
    const expected = game.current === 1 ? game.player1 : game.player2;
    if (normalizeJid(expected.jid) !== playerJid) return undefined;
    const index = parseMove(rawMove);
    if (index < 0) return response(game, '⚠️ Invalid move. Use A1 through C3, for example: .ttt A1', [playerJid]);
    if (game.board[index]) return response(game, '⚠️ That position is already occupied. Choose another square.', [playerJid]);

    game.board[index] = game.current === 1 ? '❌' : '⭕';
    const winner = winningSymbol(game.board);
    if (winner) {
      const winnerJid = game.current === 1 ? game.player1.jid : game.player2.jid;
      const result = response(game, `🏆 𝗧𝗜𝗖-𝗧𝗔𝗖-𝗧𝗢𝗘\n\n${formatBoard(game.board)}\n\n✦ Winner : ${playerMention(winnerJid)}\n✦ Symbol : ${winner}\n✦ Result : Victory`, [game.player1.jid, game.player2.jid]);
      this.cleanup(game);
      return result;
    }
    if (game.board.every(Boolean)) {
      const result = response(game, `🤝 𝗧𝗜𝗖-𝗧𝗔𝗖-𝗧𝗢𝗘\n\n${formatBoard(game.board)}\n\n✦ Result : Draw\n✦ No winning line was completed.`, [game.player1.jid, game.player2.jid]);
      this.cleanup(game);
      return result;
    }
    game.current = game.current === 1 ? 2 : 1;
    if (game.turnTimer) clearTimeout(game.turnTimer);
    game.turnTimer = this.schedule(game, () => this.expireTtt(game), this.turnMs);
    const next = game.current === 1 ? game.player1 : game.player2;
    return response(game, formatTtt(game, `Turn: ${playerMention(next.jid)} ${game.current === 1 ? '❌' : '⭕'}`), [game.player1.jid, game.player2.jid]);
  }

  private expireTtt(game: TttSession): void {
    const loser = game.current === 1 ? game.player1 : game.player2;
    const winner = game.current === 1 ? game.player2 : game.player1;
    void this.emit(game, response(game, `⌛ Time expired.\n\n✦ Player : ${playerMention(loser.jid)}\n✦ Winner : ${playerMention(winner.jid)}`, [loser.jid, winner.jid]));
    this.cleanup(game);
  }

  private giveUpTtt(game: TttSession, playerJid: string): GameResponse | undefined {
    if (!game.accepted) return undefined;
    if (playerJid !== normalizeJid(game.player1.jid) && playerJid !== normalizeJid(game.player2.jid)) return undefined;
    const winner = playerJid === normalizeJid(game.player1.jid) ? game.player2 : game.player1;
    const result = response(game, `🏳️ ${playerMention(playerJid)} gave up.\n\n🏆 Winner: ${playerMention(winner.jid)}`, [playerJid, winner.jid]);
    this.cleanup(game);
    return result;
  }

  private tttUsage(scope: GameScope): GameResponse {
    const fake: TttSession = {
      type: 'ttt', id: this.createId('ttt'), scope,
      player1: { jid: '', score: 0 }, player2: { jid: '', score: 0 }, accepted: false,
      board: [], current: 1,
    };
    return response(fake, 'Usage: .ttt @user\nThe challenged player accepts with .ttt accept.');
  }

  private cleanup(game: Session): void {
    if (game.type === 'wcg') {
      if (game.lobbyTimer) clearTimeout(game.lobbyTimer);
      if (game.turnTimer) clearTimeout(game.turnTimer);
    } else {
      if (game.challengeTimer) clearTimeout(game.challengeTimer);
      if (game.turnTimer) clearTimeout(game.turnTimer);
    }
    this.sessions.delete(scopeKey(game.scope));
  }
}

export const gameManager = new GameManager();

// ============================================================
// Poll Game Engine — Shared Types
// Centralized poll-based game infrastructure (WYR, Quiz, and any
// future poll game that plugs into the same engine).
// ============================================================

import type { NativeTableContent } from '../../utils/native-rich.js';
import type { GameAI } from './ai.js';
import type { GameSchedule } from './config.js';

/** Where a game lives — always isolated per session + group. */
export interface GameScope {
  sessionId: string;
  chatJid: string;
}

export type PollGameType = 'wyr' | 'quiz';

// ── AI-generated content ───────────────────────────────────

export interface WyrContent {
  question: string;
  optionA: string;
  optionB: string;
}

export interface QuizQuestionContent {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

// ── In-game question (one per poll) ────────────────────────

export interface PollQuestion {
  /** Stable question id inside the game ("q0", "q1", ...). */
  id: string;
  prompt: string;
  options: string[];
  /** Quiz only — NEVER sent to the group before expiry. */
  correctIndex?: number;
  /** Quiz only — revealed together with the correct answer. */
  explanation?: string;
  /** Quiz only — category label (Mathematics, History, ...). */
  category?: string;
  /** Quiz only — difficulty label. */
  difficulty?: string;
  /** WhatsApp poll creation message id (bound after send). */
  pollMsgId?: string;
  /** Base64 of the poll's messageSecret (vote decryption key). */
  messageSecret?: string;
  /** Epoch ms the poll was created. */
  createdAt: number;
  /** Epoch ms the poll closes — app-level freeze deadline. */
  expiresAt: number;
  status: 'open' | 'closed';
  /** voterJid → optionIndex (single-select, latest vote wins). */
  votes: Record<string, number>;
}

// ── Game state ─────────────────────────────────────────────

export interface PollGameState {
  id: string;
  type: PollGameType;
  scope: GameScope;
  status: 'active' | 'finished';
  createdAt: number;
  /** Overall game expiry; no new poll may be opened after this time. */
  endsAt: number;
  /** Centralized schedule: total game duration and per-question interval. */
  schedule: GameSchedule;
  players: Record<string, { jid: string; score: number }>;
  questions: PollQuestion[];
  currentQuestion: number;
  configuration: Record<string, unknown>;
}

/** Serialized snapshot used for persistence (JSON-safe). */
export interface PollGameSnapshot extends PollGameState {
  timers: unknown[]; // retained for shape parity; never serialized values
}

// ── Events emitted by the engine ───────────────────────────

export interface PollEvent {
  scope: GameScope;
  gameType: PollGameType;
  gameId: string;
  /** The question this event belongs to (needed to attach the poll key). */
  questionId?: string;
  text?: string;
  mentions?: string[];
  /** When present, the caller must send a WhatsApp poll and report the key back. */
  poll?: {
    name: string;
    values: string[];
    selectableCount: number;
    /** Native timed-poll expiry (fork maps this to pollCreationMessage.endTime). */
    endDate?: Date;
    /** Vote decryption key — MUST be the same buffer passed to sendMessage. */
    messageSecret: Buffer;
  };
  /** Native GenATableUXPrimitive ranking (with plain-text fallback). */
  nativeTable?: NativeTableContent;
  tableFallbackText?: string;
  editKey?: unknown;
}

export type PollEventHandler = (event: PollEvent) => Promise<{ key?: unknown; sent?: boolean } | void> | void;

// ── Incoming vote (raw, encrypted) ─────────────────────────

export interface DecryptedVote {
  /** optionIndex (into the question.options array) or -1 when unknown/removed. */
  optionIndex: number;
  /** The raw selected-option digest(s) as hex. */
  selectedHex: string[];
  /** True when the player explicitly removed their selection. */
  removed?: boolean;
}

export interface EncryptedVote {
  encPayload?: Uint8Array | Buffer | null;
  encIv?: Uint8Array | Buffer | null;
}

export interface PollVoteInput {
  scope: GameScope;
  /** The poll creation message id the vote refers to. */
  pollMsgId: string;
  /**
   * The RAW key-author JID of the vote message (what the fork's
   * getKeyAuthor() returns) — used verbatim in the HMAC sign + GCM AAD.
   * NEVER normalize/strip device suffixes before passing this in, or
   * decryption will fail and the vote will be safely ignored.
   */
  voterJid: string;
  /** Encrypted vote payload from pollUpdateMessage.vote. */
  vote: EncryptedVote;
  /** Optional already-decrypted vote event data from Baileys' messages.update path. */
  decrypted?: DecryptedVote;
  /**
   * Creator JID derived from the actual pollCreationMessageKey using the
   * installed fork's getKeyAuthor(). This is authoritative for decryption;
   * credential-derived candidates remain as compatibility fallbacks.
   */
  pollCreatorJid?: string;
  /** Our own JID (creds.me.id — may carry a :N device suffix). */
  meId: string;
  /**
   * Our own LID JID (creds.me.lid) for LID-migrated accounts. The voter's
   * client may have encrypted the pollCreatorJid using the @lid form — the
   * decrypt layer tries all JID permutations (phone/LID × raw/stripped) and
   * GCM auth picks the correct one deterministically.
   */
  meLid?: string;
}

// ── Game API configuration (per-session) ───────────────────

export interface GameApiConfig {
  apiKey?: string;
  model?: string;
  endpoint?: string;
}

// ── Plugin interface (future games plug into the engine) ───

export interface PollGamePlugin {
  type: PollGameType;
  /** Validate the command args and compute total game duration (ms). Returns null when invalid. */
  parseDuration(args: string[], now: number): number | null;
  /** One-line usage string shown when args are invalid. */
  usage(prefix?: string): string;
  /** Build the first question + poll event; called with AI + engine helpers. */
  start(
    engine: PollGameEngineApi,
    scope: GameScope,
    game: PollGameState,
    durationMs: number,
    now: number
  ): Promise<PollEvent | undefined>;
  /** Called when a question poll expires (freeze → score → next/finish). */
  onQuestionExpired(
    engine: PollGameEngineApi,
    game: PollGameState,
    question: PollQuestion,
    now: number
  ): Promise<PollEvent[]>;
  /** Render the poll header text for a question. */
  renderPollHeader(game: PollGameState, question: PollQuestion, now: number): string;
}

/**
 * The API surface a plugin sees — the engine's public methods
 * (poll creation, vote binding, timers, ranking, cleanup).
 */
export interface PollGameEngineApi {
  /** AI provider — used ONLY for content generation. */
  ai: GameAI;
  createQuestion(
    scope: GameScope,
    game: PollGameState,
    prompt: string,
    options: string[],
    extra: Partial<PollQuestion> & { durationMs: number }
  ): PollQuestion;
  scheduleExpiry(scope: GameScope, game: PollGameState, question: PollQuestion, now: number): void;
  /** Cleanup-only: clears timers, unregisters secrets, removes state. Never emits. */
  finishGame(game: PollGameState): Promise<void>;
  emit(event: PollEvent): Promise<{ key?: unknown; sent?: boolean } | void>;
}

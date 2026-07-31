// ============================================================
// WA-Bridge — Smart Join Manager
// Randomized scheduling, configurable throttle, failure detection
// ============================================================

import type { BridgeWASocket as WASocket } from '../whatsapp/baileys-types.js';
import type { JoinManagerState } from '../types/index.js';
import { cmdJoin } from '../whatsapp/commands/lifecycle.js';
import { loadBucket, loadSessionMeta, updateSessionMeta } from './workspace.js';
import { logger } from '../utils/logger.js';

// ── Settings ──────────────────────────────────────────────

export interface JoinSettings {
  /** Minimum delay between join attempts (ms) */
  minDelayMs: number;
  /** Maximum delay between join attempts (ms) */
  maxDelayMs: number;
  /** Maximum number of links to attempt per run (0 = unlimited) */
  maxLinksPerRun: number;
  /** Max consecutive restriction errors before stopping */
  restrictionThreshold: number;
}

export const DEFAULT_JOIN_SETTINGS: JoinSettings = {
  minDelayMs: 5_000,
  maxDelayMs: 12_000,
  maxLinksPerRun: 0,
  restrictionThreshold: 5,
};

// ── Stop flag for cmdJoinAll (WhatsApp-side joinall) ──────
const joinAllStop = new Set<string>(); // sessionId
export function stopJoinAll(sessionId: string): void { joinAllStop.add(sessionId); }
export function clearJoinAllStop(sessionId: string): void { joinAllStop.delete(sessionId); }
export function isJoinAllStopped(sessionId: string): boolean { return joinAllStop.has(sessionId); }

// ── Error Classification ──────────────────────────────────

const RESTRICTION_PATTERNS =
  /rate[-\s]?limit|rate.over.limit|429|spam|temporar|restrict|flood|banned|block|cooldown|account.limit|too.many|not.allowed/iu;

const DEAD_LINK_PATTERNS =
  /revoked|expired|invalid|not.found|does.not.exist|no.longer/iu;

const ALREADY_JOINED_PATTERNS =
  /already|participant|member/iu;

const FULL_GROUP_PATTERNS =
  /full|size.limit|maximum/iu;

function classifyJoinError(error: string): 'restriction' | 'dead' | 'already' | 'full' | 'network' | 'unknown' {
  if (RESTRICTION_PATTERNS.test(error)) return 'restriction';
  if (DEAD_LINK_PATTERNS.test(error)) return 'dead';
  if (ALREADY_JOINED_PATTERNS.test(error)) return 'already';
  if (FULL_GROUP_PATTERNS.test(error)) return 'full';
  if (/timeout|ECONNRESET|ENOTFOUND|network|socket/iu.test(error)) return 'network';
  return 'unknown';
}

// ── Shuffle ───────────────────────────────────────────────

/** Fisher-Yates in-place shuffle — called fresh on every run */
function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = temp;
  }
  return shuffled;
}

// ── State Helpers ─────────────────────────────────────────

const controllers = new Map<string, { cancelled: boolean }>();
const listeners = new Map<string, Set<(state: JoinManagerState) => Promise<void> | void>>();

function initialState(): JoinManagerState {
  return {
    status: 'idle', cursor: 0, total: 0, joined: 0, skipped: 0, failed: 0,
    consecutiveRestrictions: 0, updatedAt: Date.now(), logs: [],
  };
}

export function getJoinManagerState(telegramId: string, sessionId: string): JoinManagerState {
  return loadSessionMeta(telegramId, sessionId)?.joinManager ?? initialState();
}

function persist(telegramId: string, sessionId: string, state: JoinManagerState): void {
  state.updatedAt = Date.now();
  state.logs = state.logs.slice(-50);
  updateSessionMeta(telegramId, sessionId, { joinManager: state });
  for (const listener of listeners.get(sessionId) ?? []) void listener(state);
}

export function subscribeJoinManager(
  sessionId: string,
  listener: (state: JoinManagerState) => Promise<void> | void
): () => void {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => set.delete(listener);
}

// ── Controls ──────────────────────────────────────────────

export function pauseJoinManager(telegramId: string, sessionId: string): JoinManagerState {
  const state = getJoinManagerState(telegramId, sessionId);
  if (state.status === 'running') state.status = 'paused';
  state.logs.push('⏸ Paused by user');
  persist(telegramId, sessionId, state);
  return state;
}

export function stopJoinManager(telegramId: string, sessionId: string): JoinManagerState {
  const controller = controllers.get(sessionId);
  if (controller) controller.cancelled = true;
  const state = getJoinManagerState(telegramId, sessionId);
  state.status = 'stopped';
  state.logs.push('⏹ Stopped by user');
  persist(telegramId, sessionId, state);
  return state;
}

// ── Main Engine ───────────────────────────────────────────

export async function startJoinManager(
  telegramId: string,
  sessionId: string,
  socket: WASocket,
  settings: Partial<JoinSettings> = {}
): Promise<void> {
  // Resume logic
  if (controllers.has(sessionId)) {
    const state = getJoinManagerState(telegramId, sessionId);
    if (state.status === 'paused') {
      state.status = 'running';
      state.logs.push('▶ Resumed');
      persist(telegramId, sessionId, state);
    }
    return;
  }

  const cfg: JoinSettings = { ...DEFAULT_JOIN_SETTINGS, ...settings };

  // Load and shuffle the active bucket on every fresh start
  const rawLinks = loadBucket(telegramId, 'active').map((entry) => entry.link);
  const links = shuffleArray(rawLinks);

  // Apply per-run cap if set
  const effectiveLinks = cfg.maxLinksPerRun > 0 ? links.slice(0, cfg.maxLinksPerRun) : links;

  const previous = getJoinManagerState(telegramId, sessionId);
  const state: JoinManagerState = previous.status === 'paused'
    ? { ...previous, status: 'running', total: effectiveLinks.length }
    : {
        ...initialState(),
        status: 'running',
        total: effectiveLinks.length,
        startedAt: Date.now(),
        logs: [`▶ Join manager started — ${effectiveLinks.length} links (shuffled)`],
      };

  const controller = { cancelled: false };
  controllers.set(sessionId, controller);
  persist(telegramId, sessionId, state);

  try {
    while (state.cursor < effectiveLinks.length && !controller.cancelled) {
      // Pause polling
      if (state.status === 'paused') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const link = effectiveLinks[state.cursor]!;
      state.currentLink = link;
      persist(telegramId, sessionId, state);

      const result = await cmdJoin(socket, link);
      state.cursor += 1;

      if (result.success) {
        state.joined += 1;
        state.consecutiveRestrictions = 0;
        state.logs.push(`✅ Joined: ${result.title ?? result.jid ?? link}`);
      } else {
        const error = result.error ?? 'Unknown failure';
        const kind = classifyJoinError(error);

        switch (kind) {
          case 'restriction':
            state.failed += 1;
            state.consecutiveRestrictions += 1;
            state.lastError = error;
            state.logs.push(`🚫 Restricted: ${error.slice(0, 100)}`);
            break;
          case 'dead':
            state.failed += 1;
            state.consecutiveRestrictions = 0;
            state.logs.push(`💀 Dead link: ${link}`);
            break;
          case 'already':
            state.skipped += 1;
            state.consecutiveRestrictions = 0;
            state.logs.push(`⏭ Already joined: ${link}`);
            break;
          case 'full':
            state.skipped += 1;
            state.consecutiveRestrictions = 0;
            state.logs.push(`👥 Group full: ${link}`);
            break;
          case 'network':
            state.failed += 1;
            state.consecutiveRestrictions = 0;
            state.logs.push(`🌐 Network error: ${error.slice(0, 80)}`);
            break;
          default:
            state.failed += 1;
            state.consecutiveRestrictions = 0;
            state.logs.push(`❌ Failed: ${error.slice(0, 100)}`);
        }

        // Stop after N consecutive restriction failures
        if (state.consecutiveRestrictions >= cfg.restrictionThreshold) {
          state.status = 'restricted';
          state.logs.push(`🛑 Stopped — ${cfg.restrictionThreshold} consecutive restriction failures. Account protection triggered.`);
          logger.warn('[JoinManager] Restriction threshold reached', {
            sessionId, consecutiveRestrictions: state.consecutiveRestrictions,
          });
          break;
        }
      }

      persist(telegramId, sessionId, state);

      // Randomized delay between joins
      const delay = cfg.minDelayMs + Math.floor(Math.random() * (cfg.maxDelayMs - cfg.minDelayMs));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (!controller.cancelled && state.status === 'running') {
      state.status = 'completed';
      state.logs.push(`✅ Completed — Joined: ${state.joined} | Failed: ${state.failed} | Skipped: ${state.skipped}`);
    }
  } catch (error) {
    state.status = 'stopped';
    state.lastError = String(error);
    state.logs.push(`💥 Fatal error: ${String(error).slice(0, 100)}`);
    logger.error('[JoinManager] Job failed', { sessionId, error: String(error) });
  } finally {
    state.currentLink = undefined;
    persist(telegramId, sessionId, state);
    controllers.delete(sessionId);
  }
}

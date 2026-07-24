import type { BridgeWASocket as WASocket } from '../whatsapp/baileys-types.js';
import type { JoinManagerState } from '../types/index.js';
import { cmdJoin } from '../whatsapp/commands/lifecycle.js';
import { loadBucket, loadSessionMeta, updateSessionMeta } from './workspace.js';
import { logger } from '../utils/logger.js';

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
  state.logs = state.logs.slice(-30);
  updateSessionMeta(telegramId, sessionId, { joinManager: state });
  for (const listener of listeners.get(sessionId) ?? []) void listener(state);
}

export function subscribeJoinManager(sessionId: string, listener: (state: JoinManagerState) => Promise<void> | void): () => void {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => set.delete(listener);
}

export function pauseJoinManager(telegramId: string, sessionId: string): JoinManagerState {
  const state = getJoinManagerState(telegramId, sessionId);
  if (state.status === 'running') state.status = 'paused';
  state.logs.push('Paused by user');
  persist(telegramId, sessionId, state);
  return state;
}

export function stopJoinManager(telegramId: string, sessionId: string): JoinManagerState {
  const controller = controllers.get(sessionId);
  if (controller) controller.cancelled = true;
  const state = getJoinManagerState(telegramId, sessionId);
  state.status = 'stopped';
  state.logs.push('Stopped by user');
  persist(telegramId, sessionId, state);
  return state;
}

export async function startJoinManager(telegramId: string, sessionId: string, socket: WASocket): Promise<void> {
  if (controllers.has(sessionId)) {
    const state = getJoinManagerState(telegramId, sessionId);
    if (state.status === 'paused') {
      state.status = 'running';
      state.logs.push('Resumed');
      persist(telegramId, sessionId, state);
    }
    return;
  }

  const links = loadBucket(telegramId, 'active').map((entry) => entry.link);
  const previous = getJoinManagerState(telegramId, sessionId);
  const state: JoinManagerState = previous.status === 'paused'
    ? { ...previous, status: 'running', total: links.length }
    : { ...initialState(), status: 'running', total: links.length, startedAt: Date.now(), logs: ['Join manager started'] };
  const controller = { cancelled: false };
  controllers.set(sessionId, controller);
  persist(telegramId, sessionId, state);

  try {
    while (state.cursor < links.length && !controller.cancelled) {
      if (state.status === 'paused') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      const link = links[state.cursor]!;
      state.currentLink = link;
      persist(telegramId, sessionId, state);
      const result = await cmdJoin(socket, link);
      state.cursor += 1;
      if (result.success) {
        state.joined += 1;
        state.consecutiveRestrictions = 0;
        state.logs.push(`Joined ${result.title ?? result.jid ?? link}`);
      } else {
        const error = result.error ?? 'Unknown failure';
        const restricted = /rate|429|spam|temporar|restrict/iu.test(error);
        if (/already|participant/iu.test(error)) state.skipped += 1;
        else state.failed += 1;
        state.consecutiveRestrictions = restricted ? state.consecutiveRestrictions + 1 : 0;
        state.lastError = error;
        state.logs.push(`${restricted ? 'Restricted' : 'Failed'}: ${error.slice(0, 100)}`);
        if (state.consecutiveRestrictions >= 5) {
          state.status = 'restricted';
          state.logs.push('Stopped after five consecutive restriction failures');
          break;
        }
      }
      persist(telegramId, sessionId, state);
      await new Promise((resolve) => setTimeout(resolve, 5000 + Math.floor(Math.random() * 5000)));
    }
    if (!controller.cancelled && state.status === 'running') state.status = 'completed';
  } catch (error) {
    state.status = 'stopped';
    state.lastError = String(error);
    state.logs.push(`Stopped: ${String(error).slice(0, 100)}`);
    logger.error('[JoinManager] Job failed', { sessionId, error: String(error) });
  } finally {
    state.currentLink = undefined;
    persist(telegramId, sessionId, state);
    controllers.delete(sessionId);
  }
}

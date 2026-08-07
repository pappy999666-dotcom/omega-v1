// ============================================================
// Anti System — Per-Session Group Config Storage
// Stored at: workspaces/{tg_id}/sessions/{session_id}/anti-groups.json
// ============================================================

import fs from 'fs';
import path from 'path';
import { sessionDir } from '../../services/workspace.js';
import { logger } from '../../utils/logger.js';
import type {
  GroupAntiConfig,
  SessionAntiConfig,
  AntiModuleConfig,
  AntiSpamConfig,
  AntiWordsConfig,
  AntiDemoteConfig,
  AntiPromoteConfig,
  AntiAction,
  AntiDemoteMode,
  GroupSecurityMode,
  TargetMode,
} from './types.js';

// ── Defaults ──────────────────────────────────────────────

export function defaultModuleConfig(action: AntiAction = 'delete'): AntiModuleConfig {
  return {
    enabled: false,
    action,
    warnThreshold: 3,
    permitList: [],
  };
}

export function defaultSpamConfig(): AntiSpamConfig {
  return {
    ...defaultModuleConfig('kick'),
    messageLimit: 10,
    windowSeconds: 5,
  };
}

export function defaultWordsConfig(): AntiWordsConfig {
  return {
    ...defaultModuleConfig('delete'),
    words: [],
  };
}

export function defaultPromoteConfig(): AntiPromoteConfig {
  return {
    ...defaultModuleConfig('kick'),
    mode: 'restorekick',
    targetMode: 'protected',
  };
}

export function defaultDemoteConfig(): AntiDemoteConfig {
  return {
    ...defaultModuleConfig('kick'),
    mode: 'restorekick',
    targetMode: 'protected',
  };
}

// ── Path ─────────────────────────────────────────────────

function antiConfigPath(telegramId: string, sessionId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'anti-groups.json');
}

// ── I/O ──────────────────────────────────────────────────

export function loadSessionAntiConfig(
  telegramId: string,
  sessionId: string
): SessionAntiConfig {
  const p = antiConfigPath(telegramId, sessionId);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SessionAntiConfig;
  } catch (err) {
    logger.warn('[AntiSystem] Failed to parse anti config, resetting', { err: String(err) });
    return {};
  }
}

export function saveSessionAntiConfig(
  telegramId: string,
  sessionId: string,
  config: SessionAntiConfig
): void {
  const p = antiConfigPath(telegramId, sessionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
}

export function loadGroupAntiConfig(
  telegramId: string,
  sessionId: string,
  groupJid: string
): GroupAntiConfig {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  return all[groupJid] ?? { groupJid };
}

export function saveGroupAntiConfig(
  telegramId: string,
  sessionId: string,
  config: GroupAntiConfig
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  all[config.groupJid] = config;
  saveSessionAntiConfig(telegramId, sessionId, all);
}

// ── Module Helpers ────────────────────────────────────────

export function getModuleConfig<K extends keyof Omit<GroupAntiConfig, 'groupJid' | 'messages'>>(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  key: K
): GroupAntiConfig[K] | undefined {
  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  return gc[key];
}

export function setModuleConfig<K extends keyof Omit<GroupAntiConfig, 'groupJid' | 'messages'>>(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  key: K,
  value: GroupAntiConfig[K]
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  all[groupJid][key] = value;
  saveSessionAntiConfig(telegramId, sessionId, all);
}

// ── Permit Helpers ────────────────────────────────────────

export function addPermit(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  moduleKey: keyof Omit<GroupAntiConfig, 'groupJid' | 'messages'>,
  number: string
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  const mod = (all[groupJid][moduleKey] as AntiModuleConfig | undefined);
  if (!mod) return;
  if (!mod.permitList.includes(number)) {
    mod.permitList.push(number);
  }
  saveSessionAntiConfig(telegramId, sessionId, all);
}

export function removePermit(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  moduleKey: keyof Omit<GroupAntiConfig, 'groupJid' | 'messages'>,
  number: string
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) return;
  const mod = (all[groupJid][moduleKey] as AntiModuleConfig | undefined);
  if (!mod) return;
  mod.permitList = mod.permitList.filter((n) => n !== number);
  saveSessionAntiConfig(telegramId, sessionId, all);
}

// ── Custom Message ────────────────────────────────────────

export function setCustomMessage(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  key: string,
  message: string
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  if (!all[groupJid].messages) all[groupJid].messages = {};
  all[groupJid].messages![key] = message;
  saveSessionAntiConfig(telegramId, sessionId, all);
}

export function getCustomMessage(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  key: string
): string | undefined {
  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  return gc.messages?.[key];
}

// ── Warn Counts — in-memory per process ──────────────────
// key: `${sessionId}:${groupJid}:${senderNumber}:${moduleKey}`

const warnCounts = new Map<string, number>();

export function incrementWarn(
  sessionId: string,
  groupJid: string,
  senderNumber: string,
  moduleKey: string
): number {
  const key = `${sessionId}:${groupJid}:${senderNumber}:${moduleKey}`;
  const count = (warnCounts.get(key) ?? 0) + 1;
  warnCounts.set(key, count);
  return count;
}

export function resetWarn(
  sessionId: string,
  groupJid: string,
  senderNumber: string,
  moduleKey: string
): void {
  const key = `${sessionId}:${groupJid}:${senderNumber}:${moduleKey}`;
  warnCounts.delete(key);
}

export function getWarnCount(
  sessionId: string,
  groupJid: string,
  senderNumber: string,
  moduleKey: string
): number {
  const key = `${sessionId}:${groupJid}:${senderNumber}:${moduleKey}`;
  return warnCounts.get(key) ?? 0;
}

// ── AntiSpam rolling window — in-memory ──────────────────
// key: `${sessionId}:${groupJid}:${senderNumber}`

const spamWindows = new Map<string, number[]>();

export function recordSpamMessage(
  sessionId: string,
  groupJid: string,
  senderNumber: string,
  windowSeconds: number
): number {
  const key = `${sessionId}:${groupJid}:${senderNumber}`;
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  const existing = (spamWindows.get(key) ?? []).filter((t) => t > cutoff);
  existing.push(now);
  spamWindows.set(key, existing);
  return existing.length;
}

export function resetSpamWindow(
  sessionId: string,
  groupJid: string,
  senderNumber: string
): void {
  spamWindows.delete(`${sessionId}:${groupJid}:${senderNumber}`);
}

// ── AntiSpam config update ────────────────────────────────

export function setSpamLimit(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  messageLimit: number,
  windowSeconds: number
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  const existing = (all[groupJid].antispam ?? defaultSpamConfig()) as AntiSpamConfig;
  all[groupJid].antispam = { ...existing, messageLimit, windowSeconds };
  saveSessionAntiConfig(telegramId, sessionId, all);
}

// ── AntiWords helpers ─────────────────────────────────────

export function addWord(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  word: string
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  if (!all[groupJid].antiwords) all[groupJid].antiwords = defaultWordsConfig();
  const words = all[groupJid].antiwords!.words;
  if (!words.includes(word)) words.push(word);
  saveSessionAntiConfig(telegramId, sessionId, all);
}

export function removeWord(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  word: string
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]?.antiwords) return;
  all[groupJid].antiwords!.words = all[groupJid].antiwords!.words.filter((w) => w !== word);
  saveSessionAntiConfig(telegramId, sessionId, all);
}

/**
 * Append one or more words to the blocked list. Never overwrites the
 * existing list. Case-insensitive (stored lowercase), duplicate-safe,
 * Unicode-safe. Returns the words that were actually added.
 */
export function addWords(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  words: string[],
  enable = true
): string[] {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  if (!all[groupJid].antiwords) all[groupJid].antiwords = defaultWordsConfig();
  const existing = new Set(all[groupJid].antiwords!.words);
  const added: string[] = [];
  for (const raw of words) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    if (!existing.has(w)) {
      existing.add(w);
      added.push(w);
    }
  }
  all[groupJid].antiwords!.words = [...existing];
  if (enable) all[groupJid].antiwords!.enabled = true;
  saveSessionAntiConfig(telegramId, sessionId, all);
  return added;
}

/**
 * Remove one or more words from the blocked list. Returns the words
 * that were actually removed.
 */
export function removeWords(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  words: string[]
): string[] {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]?.antiwords) return [];
  const existing = new Set(all[groupJid].antiwords!.words);
  const removed: string[] = [];
  for (const raw of words) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    if (existing.has(w)) {
      existing.delete(w);
      removed.push(w);
    }
  }
  all[groupJid].antiwords!.words = [...existing];
  saveSessionAntiConfig(telegramId, sessionId, all);
  return removed;
}

/** Clear every blocked word for the group. */
export function clearWords(
  telegramId: string,
  sessionId: string,
  groupJid: string
): number {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]?.antiwords) return 0;
  const count = all[groupJid].antiwords!.words.length;
  all[groupJid].antiwords!.words = [];
  saveSessionAntiConfig(telegramId, sessionId, all);
  return count;
}

// ── AntiPromote mode update ────────────────────────────────

export function setPromoteMode(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  mode: GroupSecurityMode
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  const existing = (all[groupJid].antipromote ?? defaultPromoteConfig()) as AntiPromoteConfig;
  all[groupJid].antipromote = { ...existing, enabled: true, mode };
  saveSessionAntiConfig(telegramId, sessionId, all);
}

export function setPromoteTargetMode(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  targetMode: TargetMode
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  const existing = (all[groupJid].antipromote ?? defaultPromoteConfig()) as AntiPromoteConfig;
  all[groupJid].antipromote = { ...existing, targetMode };
  saveSessionAntiConfig(telegramId, sessionId, all);
}

// ── AntiDemote mode update ────────────────────────────────

export function setDemoteMode(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  mode: GroupSecurityMode
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  const existing = (all[groupJid].antidemote ?? defaultDemoteConfig()) as AntiDemoteConfig;
  all[groupJid].antidemote = { ...existing, enabled: true, mode };
  saveSessionAntiConfig(telegramId, sessionId, all);
}

export function setDemoteTargetMode(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  targetMode: TargetMode
): void {
  const all = loadSessionAntiConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  const existing = (all[groupJid].antidemote ?? defaultDemoteConfig()) as AntiDemoteConfig;
  all[groupJid].antidemote = { ...existing, targetMode };
  saveSessionAntiConfig(telegramId, sessionId, all);
}

/**
 * Store a legacy mode string directly in the config so the security engine
 * can apply the exact correct action chain:
 *   dwp → REVERT + WARN
 *   dnp → REVERT
 *   kwp → KICK + WARN  (no revert)
 *   knp → KICK         (no revert)
 *
 * @deprecated Use setDemoteMode with a GroupSecurityMode value for new configs.
 *   This function must remain so that existing/migrated legacy configs preserve
 *   their behaviour end-to-end rather than silently converting to the wrong mode.
 */
export function setDemotelLegacyMode(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  legacyMode: AntiDemoteMode
): void {
  // Store the legacy mode string as-is — the security engine's compat layer
  // maps it to the correct action chain at enforcement time.
  setDemoteMode(telegramId, sessionId, groupJid, legacyMode);
}

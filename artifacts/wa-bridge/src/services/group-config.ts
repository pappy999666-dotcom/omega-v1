// ============================================================
// WA-Bridge — Per-Group Event Config Storage
// Stores welcome/goodbye messages, moderation response
// templates, and per-group ban lists.
// Path: workspaces/{tg_id}/sessions/{session_id}/group-event-config.json
// ============================================================

import fs from 'fs';
import path from 'path';
import { sessionDir } from './workspace.js';
import { logger } from '../utils/logger.js';

export interface GroupEventConfig {
  groupJid: string;
  welcomeEnabled?: boolean;
  welcomeMessage?: string;
  goodbyeEnabled?: boolean;
  goodbyeMessage?: string;
  /**
   * When true, every new member who joins the group is automatically
   * blocked by the bot (protected participants are always exempt).
   */
  autoblockEnabled?: boolean;
  /** Per-action response templates: kick, warn, ban, unban, etc. */
  messages?: Record<string, string>;
  /** Soft-ban list (numbers kicked and blocked from rejoining) */
  bannedNumbers?: string[];
}

export type SessionGroupEventConfig = Record<string, GroupEventConfig>;

// ── Path Helper ───────────────────────────────────────────

function configPath(telegramId: string, sessionId: string): string {
  return path.join(sessionDir(telegramId, sessionId), 'group-event-config.json');
}

// ── I/O ──────────────────────────────────────────────────

export function loadSessionGroupEventConfig(
  telegramId: string,
  sessionId: string
): SessionGroupEventConfig {
  const p = configPath(telegramId, sessionId);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SessionGroupEventConfig;
  } catch (err) {
    logger.warn('[GroupConfig] Failed to parse group-event-config', { err: String(err) });
    return {};
  }
}

export function saveSessionGroupEventConfig(
  telegramId: string,
  sessionId: string,
  config: SessionGroupEventConfig
): void {
  const p = configPath(telegramId, sessionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
}

export function loadGroupEventConfig(
  telegramId: string,
  sessionId: string,
  groupJid: string
): GroupEventConfig {
  const all = loadSessionGroupEventConfig(telegramId, sessionId);
  return all[groupJid] ?? { groupJid };
}

export function saveGroupEventConfig(
  telegramId: string,
  sessionId: string,
  config: GroupEventConfig
): void {
  const all = loadSessionGroupEventConfig(telegramId, sessionId);
  all[config.groupJid] = config;
  saveSessionGroupEventConfig(telegramId, sessionId, all);
}

// ── Message Template Helpers ──────────────────────────────

export function setGroupMessage(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  key: string,
  message: string
): void {
  const all = loadSessionGroupEventConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  if (!all[groupJid].messages) all[groupJid].messages = {};
  all[groupJid].messages![key] = message;
  saveSessionGroupEventConfig(telegramId, sessionId, all);
}

export function getGroupMessage(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  key: string
): string | undefined {
  const gc = loadGroupEventConfig(telegramId, sessionId, groupJid);
  return gc.messages?.[key];
}

// ── Welcome / Goodbye Config ──────────────────────────────

export function setWelcomeConfig(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  enabled: boolean,
  message?: string
): void {
  const all = loadSessionGroupEventConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  all[groupJid].welcomeEnabled = enabled;
  if (message !== undefined) all[groupJid].welcomeMessage = message;
  saveSessionGroupEventConfig(telegramId, sessionId, all);
}

export function setGoodbyeConfig(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  enabled: boolean,
  message?: string
): void {
  const all = loadSessionGroupEventConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  all[groupJid].goodbyeEnabled = enabled;
  if (message !== undefined) all[groupJid].goodbyeMessage = message;
  saveSessionGroupEventConfig(telegramId, sessionId, all);
}

export function setAutoblockConfig(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  enabled: boolean
): void {
  const all = loadSessionGroupEventConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  all[groupJid].autoblockEnabled = enabled;
  saveSessionGroupEventConfig(telegramId, sessionId, all);
}

// ── Ban List Helpers ──────────────────────────────────────

export function addBannedNumber(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  number: string
): void {
  const all = loadSessionGroupEventConfig(telegramId, sessionId);
  if (!all[groupJid]) all[groupJid] = { groupJid };
  if (!all[groupJid].bannedNumbers) all[groupJid].bannedNumbers = [];
  if (!all[groupJid].bannedNumbers!.includes(number)) {
    all[groupJid].bannedNumbers!.push(number);
  }
  saveSessionGroupEventConfig(telegramId, sessionId, all);
}

export function removeBannedNumber(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  number: string
): void {
  const all = loadSessionGroupEventConfig(telegramId, sessionId);
  if (!all[groupJid]?.bannedNumbers) return;
  all[groupJid].bannedNumbers = all[groupJid].bannedNumbers!.filter((n) => n !== number);
  saveSessionGroupEventConfig(telegramId, sessionId, all);
}

export function isBannedNumber(
  telegramId: string,
  sessionId: string,
  groupJid: string,
  number: string
): boolean {
  const gc = loadGroupEventConfig(telegramId, sessionId, groupJid);
  return gc.bannedNumbers?.includes(number) ?? false;
}

export function getBanList(
  telegramId: string,
  sessionId: string,
  groupJid: string
): string[] {
  const gc = loadGroupEventConfig(telegramId, sessionId, groupJid);
  return gc.bannedNumbers ?? [];
}

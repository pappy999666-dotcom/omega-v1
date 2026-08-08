// ============================================================
// WA-Bridge — Command Tutorial Registry (platform-wide)
//
// Attaches a tutorial image/video to any registered command. The
// command list is NEVER hardcoded here — it reads the central
// command registry (MENU_CATALOG) so unknown commands are rejected
// consistently across Telegram and WhatsApp.
//
// Storage (platform-wide — shared by every session and user):
//   workspaces/_platform/tutorials.json          → index
//   workspaces/_platform/tutorials/<command>.<ext> → media file
// ============================================================

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { WORKSPACE_ROOT } from './workspace.js';
import { MENU_CATALOG } from '../whatsapp/menu-registry.js';

const TUTORIALS_INDEX = path.join(WORKSPACE_ROOT, '_platform', 'tutorials.json');
const TUTORIALS_DIR = path.join(WORKSPACE_ROOT, '_platform', 'tutorials');

export type TutorialMediaType = 'image' | 'video';

export interface TutorialRecord {
  /** Command name this tutorial is attached to (lowercase). */
  command: string;
  type: TutorialMediaType;
  /** Absolute path of the stored media file. */
  filePath: string;
  mimeType: string;
  addedAt: number;
}

// ── Registry validation (single source of truth: MENU_CATALOG) ──

/** All commands that can own a tutorial (non-hidden entries of the catalog). */
export function validTutorialCommands(): string[] {
  return Object.entries(MENU_CATALOG)
    .filter(([, entry]) => !entry.hidden)
    .map(([cmd]) => cmd);
}

export function isValidTutorialCommand(command: string): boolean {
  const cmd = String(command ?? '').trim().toLowerCase();
  if (!cmd) return false;
  const entry = MENU_CATALOG[cmd];
  return Boolean(entry && !entry.hidden);
}

// ── Persistence ────────────────────────────────────────────

export function loadTutorials(): TutorialRecord[] {
  if (!fs.existsSync(TUTORIALS_INDEX)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(TUTORIALS_INDEX, 'utf8')) as TutorialRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn('[Tutorials] index read failed', { err: String(err) });
    return [];
  }
}

function saveTutorials(tutorials: TutorialRecord[]): void {
  fs.mkdirSync(path.dirname(TUTORIALS_INDEX), { recursive: true });
  fs.writeFileSync(TUTORIALS_INDEX, JSON.stringify(tutorials, null, 2));
}

/** Tutorial attached to a command, or null. */
export function getTutorial(command: string): TutorialRecord | null {
  const cmd = String(command ?? '').trim().toLowerCase();
  return loadTutorials().find((t) => t.command === cmd) ?? null;
}

/** All stored tutorials. */
export function listTutorials(): TutorialRecord[] {
  return loadTutorials();
}

/** Delete the media file of a record (best-effort). */
function removeMediaFile(record: TutorialRecord): void {
  try {
    if (record.filePath && fs.existsSync(record.filePath)) fs.unlinkSync(record.filePath);
  } catch (err) {
    logger.warn('[Tutorials] media cleanup failed', { err: String(err) });
  }
}

/**
 * Store a tutorial media buffer against a command.
 * Rejects unknown commands — the caller must surface the valid list.
 * Replacing an existing tutorial atomically removes the old media.
 */
export function saveTutorialMedia(
  command: string,
  type: TutorialMediaType,
  buffer: Buffer,
  mimeType: string
): TutorialRecord | null {
  const cmd = String(command ?? '').trim().toLowerCase();
  if (!isValidTutorialCommand(cmd)) return null;
  if (!buffer || buffer.length === 0) return null;

  const ext = type === 'video'
    ? (mimeType.split('/')[1] ?? 'mp4').replace(/[^a-z0-9]/gi, '')
    : (mimeType.split('/')[1] ?? 'jpeg').replace(/[^a-z0-9]/gi, '');
  const safeName = cmd.replace(/[^a-z0-9_-]/gi, '');
  const fileName = `${safeName}.${ext}`;
  const filePath = path.join(TUTORIALS_DIR, fileName);

  fs.mkdirSync(TUTORIALS_DIR, { recursive: true });
  fs.writeFileSync(filePath, buffer);

  const tutorials = loadTutorials();
  const existing = tutorials.find((t) => t.command === cmd);
  if (existing) {
    removeMediaFile(existing);
    existing.type = type;
    existing.filePath = filePath;
    existing.mimeType = mimeType;
    existing.addedAt = Date.now();
  } else {
    tutorials.push({ command: cmd, type, filePath, mimeType, addedAt: Date.now() });
  }
  saveTutorials(tutorials);

  logger.info('[Tutorials] saved', { command: cmd, type });
  return getTutorial(cmd);
}

/** Remove the tutorial attached to a command. Returns true when removed. */
export function removeTutorial(command: string): boolean {
  const cmd = String(command ?? '').trim().toLowerCase();
  const tutorials = loadTutorials();
  const idx = tutorials.findIndex((t) => t.command === cmd);
  if (idx < 0) return false;
  const [removed] = tutorials.splice(idx, 1);
  if (removed) removeMediaFile(removed);
  saveTutorials(tutorials);
  logger.info('[Tutorials] removed', { command: cmd });
  return true;
}

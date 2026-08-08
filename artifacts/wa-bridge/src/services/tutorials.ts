// ============================================================
// WA-Bridge — Tutorial Content Registry
//
// Tutorial instructional content is platform-managed and contains no
// session credentials. Session Game API keys remain in each session's
// config.json and are never read by this service.
//
// Storage:
//   workspaces/_platform/tutorials.json          → content index
//   workspaces/_platform/tutorials/<unique-file>  → helper media
// ============================================================

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { WORKSPACE_ROOT } from './workspace.js';
import { MENU_CATALOG } from '../whatsapp/menu-registry.js';

const TUTORIALS_INDEX = path.join(WORKSPACE_ROOT, '_platform', 'tutorials.json');
const TUTORIALS_DIR = path.join(WORKSPACE_ROOT, '_platform', 'tutorials');
const GAME_API_TUTORIAL = 'gameapi';
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export type TutorialMediaType = 'image' | 'video';

export interface TutorialMediaAsset {
  filePath: string;
  mimeType: string;
  addedAt: number;
}

export interface TutorialRecord {
  /** Command name this tutorial is attached to (lowercase). */
  command: string;
  /** Optional instructional content managed by the admin, never a secret. */
  title?: string;
  description?: string;
  steps?: string[];
  /** Independent helper assets. Both can coexist on one tutorial. */
  helperImage?: TutorialMediaAsset;
  helperVideo?: TutorialMediaAsset;
  /** Legacy/latest asset fields retained for old readers and migration. */
  type?: TutorialMediaType;
  filePath?: string;
  mimeType?: string;
  addedAt: number;
}

export interface TutorialMedia {
  buffer: Buffer;
  type: TutorialMediaType;
  mimeType: string;
}

export function validTutorialCommands(): string[] {
  const commands = Object.entries(MENU_CATALOG)
    .filter(([, entry]) => !entry.hidden)
    .map(([cmd]) => cmd);
  return [...new Set([...commands, GAME_API_TUTORIAL])];
}

export function isValidTutorialCommand(command: string): boolean {
  const cmd = String(command ?? '').trim().toLowerCase();
  return cmd === GAME_API_TUTORIAL || Boolean(cmd && MENU_CATALOG[cmd] && !MENU_CATALOG[cmd]!.hidden);
}

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

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
}

function saveTutorials(tutorials: TutorialRecord[]): void {
  atomicWriteJson(TUTORIALS_INDEX, tutorials);
}

export function getTutorial(command: string): TutorialRecord | null {
  const cmd = String(command ?? '').trim().toLowerCase();
  return loadTutorials().find((t) => t.command === cmd) ?? null;
}

export function listTutorials(): TutorialRecord[] {
  return loadTutorials();
}

function removeMediaFile(record: TutorialMediaAsset | { filePath?: string } | undefined): void {
  try {
    if (record?.filePath && fs.existsSync(record.filePath)) fs.unlinkSync(record.filePath);
  } catch (err) {
    logger.warn('[Tutorials] media cleanup failed', { err: String(err) });
  }
}

function removeRecordAssets(record: TutorialRecord | undefined): void {
  if (!record) return;
  const paths = new Set([
    record.filePath,
    record.helperImage?.filePath,
    record.helperVideo?.filePath,
  ].filter((value): value is string => Boolean(value)));
  for (const filePath of paths) removeMediaFile({ filePath });
}

function extensionFor(type: TutorialMediaType, mimeType: string): string {
  const fallback = type === 'video' ? 'mp4' : 'jpg';
  const raw = (mimeType.split('/')[1] ?? fallback).split(';')[0]!.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return raw || fallback;
}

function assetFor(record: TutorialRecord, type: TutorialMediaType): TutorialMediaAsset | undefined {
  const asset = type === 'image' ? record.helperImage : record.helperVideo;
  if (asset) return asset;
  // Migrate old one-asset records in memory without losing their media.
  if (record.type === type && record.filePath && record.mimeType) {
    return { filePath: record.filePath, mimeType: record.mimeType, addedAt: record.addedAt };
  }
  return undefined;
}

function readAsset(asset: TutorialMediaAsset | undefined): Buffer | null {
  if (!asset?.filePath) return null;
  try {
    if (!fs.existsSync(asset.filePath)) return null;
    const buffer = fs.readFileSync(asset.filePath);
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/** Return one persisted helper asset, selecting the latest asset by default. */
export function readTutorialMedia(command: string, requestedType?: TutorialMediaType): TutorialMedia | null {
  const record = getTutorial(command);
  if (!record) return null;
  const candidates: Array<{ type: TutorialMediaType; asset?: TutorialMediaAsset }> = [
    { type: 'image', asset: assetFor(record, 'image') },
    { type: 'video', asset: assetFor(record, 'video') },
  ];
  const selected = requestedType
    ? candidates.find((candidate) => candidate.type === requestedType)
    : candidates.filter((candidate) => candidate.asset).sort((a, b) => (b.asset?.addedAt ?? 0) - (a.asset?.addedAt ?? 0))[0];
  if (!selected?.asset) return null;
  const buffer = readAsset(selected.asset);
  return buffer ? { buffer, type: selected.type, mimeType: selected.asset.mimeType } : null;
}

/** Return all available helper assets in stable image/video order. */
export function readTutorialMediaAssets(command: string): TutorialMedia[] {
  return (['image', 'video'] as TutorialMediaType[])
    .map((type) => readTutorialMedia(command, type))
    .filter((media): media is TutorialMedia => Boolean(media));
}

/**
 * Store helper media against a command. Image and video are independent:
 * replacing an image does not delete the helper video, and vice versa.
 */
export function saveTutorialMedia(
  command: string,
  type: TutorialMediaType,
  buffer: Buffer,
  mimeType: string,
): TutorialRecord | null {
  const cmd = String(command ?? '').trim().toLowerCase();
  if (!isValidTutorialCommand(cmd)) return null;
  if (type !== 'image' && type !== 'video') return null;
  if (!mimeType.startsWith(`${type}/`)) return null;
  if (!buffer || buffer.length === 0 || buffer.length > MAX_MEDIA_BYTES) return null;

  const ext = extensionFor(type, mimeType);
  const safeName = cmd.replace(/[^a-z0-9_-]/gi, '') || GAME_API_TUTORIAL;
  const fileName = `${safeName}-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const filePath = path.join(TUTORIALS_DIR, fileName);
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(TUTORIALS_DIR, { recursive: true, mode: 0o700 });

  try {
    fs.writeFileSync(tempPath, buffer, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    const tutorials = loadTutorials();
    const existing = tutorials.find((t) => t.command === cmd);
    const oldAsset = existing ? assetFor(existing, type) : undefined;
    const asset: TutorialMediaAsset = { filePath, mimeType, addedAt: Date.now() };
    const record: TutorialRecord = {
      ...(existing ?? {}),
      command: cmd,
      ...(type === 'image' ? { helperImage: asset } : { helperVideo: asset }),
      // Keep legacy fields pointing at the latest upload for old consumers.
      type,
      filePath,
      mimeType,
      addedAt: asset.addedAt,
    };
    const next = existing
      ? tutorials.map((t) => (t.command === cmd ? record : t))
      : [...tutorials, record];
    saveTutorials(next);
    if (oldAsset && oldAsset.filePath !== filePath) removeMediaFile(oldAsset);
    logger.info('[Tutorials] saved', { command: cmd, type, bytes: buffer.length });
    return record;
  } catch (err) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* best effort */ }
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best effort */ }
    logger.warn('[Tutorials] media save failed', { command: cmd, type, err: String(err) });
    return null;
  }
}

export function removeTutorial(command: string): boolean {
  const cmd = String(command ?? '').trim().toLowerCase();
  const tutorials = loadTutorials();
  const idx = tutorials.findIndex((t) => t.command === cmd);
  if (idx < 0) return false;
  const [removed] = tutorials.splice(idx, 1);
  saveTutorials(tutorials);
  removeRecordAssets(removed);
  logger.info('[Tutorials] removed', { command: cmd });
  return true;
}

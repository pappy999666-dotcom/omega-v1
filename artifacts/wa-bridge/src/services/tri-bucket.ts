// ============================================================
// WA-Bridge — Tri-Bucket Validator
// Main → Active → Dead pipeline with headless validation
// ============================================================

import path from 'path';
import fs from 'fs';
import type { BucketEntry, ValidationResult } from '../types/index.js';
import {
  loadBucket,
  saveBucket,
  moveToActiveBucket,
  moveToDeadBucket,
  exportDir,
} from './workspace.js';
import { isDeadLinkError, isGroupFullError } from '../utils/error-recovery.js';
import { jitter } from '../utils/delay.js';
import { logger } from '../utils/logger.js';
import { recordFailure, recordSuccess, isCircuitOpen } from './circuit-breaker.js';
import type { WASocket } from '@crysnovax/baileys';

// Track auto-filter running state per user
const autoFilterRunning = new Set<string>();

// ── Validation ────────────────────────────────────────────

/**
 * Extract invite code from a WhatsApp group link.
 * Handles: https://chat.whatsapp.com/XXXX, wa.me/join/XXXX
 */
export function extractInviteCode(link: string): string | null {
  const match = link.match(/(?:chat\.whatsapp\.com|wa\.me\/join)\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

/**
 * Validate a single group link using Baileys groupGetInviteInfo.
 * Does NOT join the group — headless validation only.
 */
export async function validateLink(
  socket: WASocket,
  link: string
): Promise<ValidationResult> {
  const code = extractInviteCode(link);

  if (!code) {
    return { link, isValid: false, reason: 'Invalid link format' };
  }

  try {
    const info = await socket.groupGetInviteInfo(code);

    if (!info) {
      return { link, isValid: false, reason: 'Group not found' };
    }

    return {
      link,
      jid: info.id,
      title: info.subject,
      memberCount: info.size,
      description: info.desc,
      isValid: true,
    };
  } catch (err) {
    if (isDeadLinkError(err)) {
      return { link, isValid: false, reason: 'Link revoked or expired' };
    }
    if (isGroupFullError(err)) {
      // Full groups still have valid links — mark active but note full status
      return { link, isValid: true, reason: 'Group is full' };
    }
    return { link, isValid: false, reason: String(err) };
  }
}

// ── Batch Validation ──────────────────────────────────────

export interface ValidateAllResult {
  activated: number;
  killed: number;
  errors: number;
  rateLimitPaused: boolean;
}

/**
 * Run the full validation pipeline for a user's main bucket.
 * Moves validated links to active/dead, auto-pauses on rate limits.
 */
export async function validateAllLinks(
  telegramId: string,
  sessionId: string,
  socket: WASocket,
  onProgress?: (msg: string) => Promise<void>
): Promise<ValidateAllResult> {
  const main = loadBucket(telegramId, 'main').filter(
    (e) => e.status === 'unvalidated'
  );

  const result: ValidateAllResult = {
    activated: 0,
    killed: 0,
    errors: 0,
    rateLimitPaused: false,
  };

  const toActivate: BucketEntry[] = [];
  const toDead: BucketEntry[] = [];
  let consecutiveRateErrors = 0;

  for (let i = 0; i < main.length; i++) {
    const entry = main[i]!;

    // Circuit breaker check
    if (isCircuitOpen(telegramId, sessionId, 'validator')) {
      result.rateLimitPaused = true;
      await onProgress?.(`🚦 Circuit open — pausing validation for 1 hour`);
      break;
    }

    try {
      const vr = await validateLink(socket, entry.link);

      if (vr.isValid) {
        toActivate.push({
          ...entry,
          jid: vr.jid,
          title: vr.title,
          memberCount: vr.memberCount,
          validatedAt: Date.now(),
          status: 'active',
        });
        result.activated++;
        consecutiveRateErrors = 0;
        recordSuccess(telegramId, sessionId, 'validator');
      } else {
        toDead.push({
          ...entry,
          deadReason: vr.reason,
          validatedAt: Date.now(),
          status: 'dead',
        });
        result.killed++;
      }

      if (i % 10 === 0 && onProgress) {
        await onProgress(
          `🔍 Validating ${i + 1}/${main.length}… ✅${result.activated} 💀${result.killed}`
        );
      }

      // Jitter between validations to avoid rate limits
      await jitter(800, 2000);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('rate') || msg.includes('429')) {
        consecutiveRateErrors++;
        const tripped = recordFailure(telegramId, sessionId, 'validator');
        if (consecutiveRateErrors >= 5 || tripped) {
          result.rateLimitPaused = true;
          await onProgress?.(
            `🚦 5 consecutive rate errors — auto-pausing for 1 hour`
          );
          break;
        }
      }
      result.errors++;
      logger.warn(`[Validator] Error on ${entry.link}: ${msg}`);
    }
  }

  // Persist results
  if (toActivate.length > 0) moveToActiveBucket(telegramId, toActivate);
  if (toDead.length > 0) moveToDeadBucket(telegramId, toDead);

  return result;
}

// ── Auto-Filter Engine ────────────────────────────────────

export function isAutoFilterRunning(telegramId: string): boolean {
  return autoFilterRunning.has(telegramId);
}

export function stopAutoFilter(telegramId: string): void {
  autoFilterRunning.delete(telegramId);
}

export async function startAutoFilter(
  telegramId: string,
  sessionId: string,
  socket: WASocket,
  onProgress: (msg: string) => Promise<void>
): Promise<void> {
  if (autoFilterRunning.has(telegramId)) return;
  autoFilterRunning.add(telegramId);

  try {
    while (autoFilterRunning.has(telegramId)) {
      const main = loadBucket(telegramId, 'main').filter(
        (e) => e.status === 'unvalidated'
      );

      if (main.length === 0) {
        await onProgress('✅ Auto-filter complete — all links processed');
        break;
      }

      await validateAllLinks(telegramId, sessionId, socket, onProgress);

      // If rate limited, pause for 1 hour before continuing
      if (isCircuitOpen(telegramId, sessionId, 'validator')) {
        await jitter(3_600_000, 3_600_000);
      }
    }
  } finally {
    autoFilterRunning.delete(telegramId);
  }
}

// ── Export ────────────────────────────────────────────────

export function exportBucket(
  telegramId: string,
  bucket: 'main' | 'active' | 'dead',
  format: 'txt' | 'csv' | 'html'
): string {
  const entries = loadBucket(telegramId, bucket);
  const dir = exportDir(telegramId);
  const ts = new Date().toISOString().slice(0, 10);
  const filename = `${bucket}-${ts}.${format}`;
  const filepath = path.join(dir, filename);

  if (format === 'txt') {
    fs.writeFileSync(filepath, entries.map((e) => e.link).join('\n'));
  } else if (format === 'csv') {
    const header = 'link,jid,title,memberCount,status,addedAt,validatedAt\n';
    const rows = entries
      .map(
        (e) =>
          `"${e.link}","${e.jid ?? ''}","${(e.title ?? '').replace(/"/g, '""')}",${e.memberCount ?? ''},${e.status},${e.addedAt},${e.validatedAt ?? ''}`
      )
      .join('\n');
    fs.writeFileSync(filepath, header + rows);
  } else {
    const rows = entries
      .map(
        (e) =>
          `<tr><td><a href="${e.link}">${e.link}</a></td><td>${e.title ?? ''}</td><td>${e.memberCount ?? ''}</td><td>${e.status}</td></tr>`
      )
      .join('\n');
    const html = `<!DOCTYPE html><html><head><title>${bucket} Bucket</title>
<style>body{font-family:sans-serif;} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ccc;padding:6px}</style>
</head><body><h1>${bucket.toUpperCase()} BUCKET — ${entries.length} links</h1>
<table><tr><th>Link</th><th>Title</th><th>Members</th><th>Status</th></tr>${rows}</table></body></html>`;
    fs.writeFileSync(filepath, html);
  }

  return filepath;
}

// ── Master Bucket (Admin) ─────────────────────────────────

export function getMasterActiveBucket(userIds: string[]): BucketEntry[] {
  const all: BucketEntry[] = [];
  const seen = new Set<string>();

  for (const uid of userIds) {
    const active = loadBucket(uid, 'active');
    for (const e of active) {
      const key = e.jid ?? e.link;
      if (!seen.has(key)) {
        all.push(e);
        seen.add(key);
      }
    }
  }

  return all;
}

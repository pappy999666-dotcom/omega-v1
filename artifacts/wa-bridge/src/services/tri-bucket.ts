// ============================================================
// WA-Bridge — Tri-Bucket Validator
// Main → Active → Dead pipeline with headless validation
// Premium live dashboard, session failover, high-volume support
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
import type { BridgeWASocket as WASocket } from '../whatsapp/baileys-types.js';

// Track auto-filter running state per user
const autoFilterRunning = new Set<string>();

// ── WhatsApp Invite Link Extraction ──────────────────────

/**
 * Extract all unique WhatsApp group invite links from any text.
 * Handles links embedded in paragraphs, emojis, forwarded messages,
 * captions, mixed content, and thousands of lines.
 */
export function extractAllInviteLinks(text: string): string[] {
  // Primary: standard chat.whatsapp.com links
  const primary = text.matchAll(
    /https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/gu
  );
  // Secondary: wa.me/join short links
  const secondary = text.matchAll(
    /https?:\/\/wa\.me\/join\/([A-Za-z0-9_-]{10,})/gu
  );
  // Tertiary: bare codes in invite-share messages (e.g. "chat.whatsapp.com/AbCdEf…")
  const tertiary = text.matchAll(
    /chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/gu
  );

  const seen = new Set<string>();
  const links: string[] = [];

  for (const match of [...primary, ...secondary, ...tertiary]) {
    const normalized = `https://chat.whatsapp.com/${match[1]}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      links.push(normalized);
    }
  }

  return links;
}

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
    return { link, isValid: false, reason: String(err), transient: true };
  }
}

// ── Batch Validation ──────────────────────────────────────

export interface ValidateAllResult {
  activated: number;
  killed: number;
  errors: number;
  retries: number;
  remaining: number;
  rateLimitPaused: boolean;
  sessionSwitched: boolean;
}

/** Formats a number with thousand separators */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Build the live Telegram validator dashboard (HTML) */
function buildDashboard(opts: {
  queue: number;
  live: number;
  dead: number;
  pending: number;
  sessionId: string;
  sessionIndex: number;
  speed: string;
  status: string;
}): string {
  const row = (label: string, value: string | number): string =>
    `${label.padEnd(11)}${String(value)}`;

  const statusLine =
    opts.status === 'RATE LIMITED'
      ? '⚠ RATE LIMITED'
      : opts.status === 'SWITCHING'
      ? '↻ SWITCHING'
      : '● ONLINE';

  return [
    `<blockquote>`,
    `<b>◈ OMEGA VALIDATOR</b>`,
    ``,
    row('Queue', fmt(opts.queue)),
    row('Live', fmt(opts.live)),
    row('Dead', fmt(opts.dead)),
    row('Pending', fmt(opts.pending)),
    ``,
    row('Session', `#${String(opts.sessionIndex).padStart(2, '0')}`),
    row('Status', statusLine),
    row('Speed', `${opts.speed} links/min`),
    `</blockquote>`,
  ].join('\n');
}

/**
 * Run the full validation pipeline for a user's main bucket.
 * Moves validated links to active/dead, auto-pauses on rate limits.
 * Supports live dashboard progress and automatic session failover.
 */
export async function validateAllLinks(
  telegramId: string,
  sessionId: string,
  socket: WASocket,
  onProgress?: (msg: string) => Promise<void>,
  getAlternativeSocket?: (currentSessionId: string) => { socket: WASocket; sessionId: string } | null
): Promise<ValidateAllResult> {
  const main = loadBucket(telegramId, 'main').filter(
    (e) => e.status === 'unvalidated'
  );

  const result: ValidateAllResult = {
    activated: 0,
    killed: 0,
    errors: 0,
    retries: 0,
    remaining: main.length,
    rateLimitPaused: false,
    sessionSwitched: false,
  };

  const toActivate: BucketEntry[] = [];
  const toDead: BucketEntry[] = [];
  let consecutiveRateErrors = 0;
  const startedAt = Date.now();
  let currentSocket = socket;
  let currentSessionId = sessionId;
  let sessionIndex = 1;

  for (let i = 0; i < main.length; i++) {
    const entry = main[i]!;

    // Circuit breaker check
    if (isCircuitOpen(telegramId, currentSessionId, 'validator')) {
      // Try session failover before giving up
      if (getAlternativeSocket) {
        const alt = getAlternativeSocket(currentSessionId);
        if (alt) {
          result.sessionSwitched = true;
          sessionIndex++;
          currentSocket = alt.socket;
          currentSessionId = alt.sessionId;
          consecutiveRateErrors = 0;
          await onProgress?.(buildDashboard({
            queue: main.length,
            live: result.activated,
            dead: result.killed,
            pending: main.length - i,
            sessionId: currentSessionId,
            sessionIndex,
            speed: ((i / Math.max((Date.now() - startedAt) / 60000, 0.01))).toFixed(1),
            status: 'SWITCHING',
          }));
          await jitter(2000, 4000);
          continue;
        }
      }

      result.rateLimitPaused = true;
      result.remaining = main.length - i;
      await onProgress?.(buildDashboard({
        queue: main.length,
        live: result.activated,
        dead: result.killed,
        pending: result.remaining,
        sessionId: currentSessionId,
        sessionIndex,
        speed: '0.0',
        status: 'RATE LIMITED',
      }));
      break;
    }

    // Emit live dashboard on every link
    const elapsed = Math.max((Date.now() - startedAt) / 60000, 0.01);
    const speed = (i / elapsed).toFixed(1);
    await onProgress?.(buildDashboard({
      queue: main.length,
      live: result.activated,
      dead: result.killed,
      pending: main.length - i,
      sessionId: currentSessionId,
      sessionIndex,
      speed,
      status: 'ONLINE',
    }));

    try {
      const vr = await validateLink(currentSocket, entry.link);

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
        recordSuccess(telegramId, currentSessionId, 'validator');

        // Flush to disk every 50 to avoid data loss on crash
        if (toActivate.length > 0 && toActivate.length % 50 === 0) {
          moveToActiveBucket(telegramId, toActivate.splice(0));
        }
      } else if (vr.transient) {
        result.errors++;
        logger.warn(`[Validator] Transient failure preserved in Main: ${entry.link} — ${vr.reason}`);
      } else {
        toDead.push({
          ...entry,
          deadReason: vr.reason,
          validatedAt: Date.now(),
          status: 'dead',
        });
        result.killed++;

        // Flush dead links every 50
        if (toDead.length > 0 && toDead.length % 50 === 0) {
          moveToDeadBucket(telegramId, toDead.splice(0));
        }
      }

      await jitter(800, 2000);
    } catch (err) {
      const msg = String(err);
      if (/rate|429|spam|flood|restrict|too.many/iu.test(msg)) {
        consecutiveRateErrors++;
        result.retries++;
        const tripped = recordFailure(telegramId, currentSessionId, 'validator');

        if (consecutiveRateErrors >= 5 || tripped) {
          // Try session failover
          if (getAlternativeSocket) {
            const alt = getAlternativeSocket(currentSessionId);
            if (alt) {
              result.sessionSwitched = true;
              sessionIndex++;
              currentSocket = alt.socket;
              currentSessionId = alt.sessionId;
              consecutiveRateErrors = 0;
              logger.info(`[Validator] Session failover → ${alt.sessionId}`);
              await jitter(3000, 6000);
              continue;
            }
          }

          result.rateLimitPaused = true;
          result.remaining = main.length - i;
          await onProgress?.(buildDashboard({
            queue: main.length,
            live: result.activated,
            dead: result.killed,
            pending: result.remaining,
            sessionId: currentSessionId,
            sessionIndex,
            speed: '0.0',
            status: 'RATE LIMITED',
          }));
          break;
        }
        await jitter(5000, 15000);
      }
      result.errors++;
      logger.warn(`[Validator] Error on ${entry.link}: ${msg}`);
    }
  }

  // Persist remaining buffered results
  if (toActivate.length > 0) moveToActiveBucket(telegramId, toActivate);
  if (toDead.length > 0) moveToDeadBucket(telegramId, toDead);

  result.remaining = loadBucket(telegramId, 'main').filter((e) => e.status === 'unvalidated').length;

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
  onProgress: (msg: string) => Promise<void>,
  getAlternativeSocket?: (currentSessionId: string) => { socket: WASocket; sessionId: string } | null
): Promise<void> {
  if (autoFilterRunning.has(telegramId)) return;
  autoFilterRunning.add(telegramId);

  try {
    while (autoFilterRunning.has(telegramId)) {
      const main = loadBucket(telegramId, 'main').filter(
        (e) => e.status === 'unvalidated'
      );

      if (main.length === 0) {
        await onProgress(
          `<blockquote><b>◈ OMEGA VALIDATOR</b>\n\nStatus     ✅ COMPLETE\nAll links processed.</blockquote>`
        );
        break;
      }

      const result = await validateAllLinks(telegramId, sessionId, socket, onProgress, getAlternativeSocket);

      // If rate limited with no session to fall over to, pause for 1 hour
      if (result.rateLimitPaused && !result.sessionSwitched) {
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

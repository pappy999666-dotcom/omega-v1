// ============================================================
// WA-Bridge — Auto-Promote Scheduler
// Runs allstatus at 7:00 AM and 6:00 PM WAT (UTC+1) daily
// Persisted per-session, history tracked per run
// ============================================================

import type { AutoPromoteJob, AutoPromoteRun } from '../types/index.js';
import { loadAllSessions, updateSessionMeta, loadSessionMeta, getAllUserIds } from './workspace.js';
import { getSocket, isFrozen } from '../whatsapp/socket-manager.js';
import { cmdAllStatus } from '../whatsapp/commands/all-status.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

// WAT = UTC+1
const WAT_OFFSET_MS = 1 * 60 * 60 * 1000;

// Jobs stored in workspaces/{telegramId}/auto-promote.json
function jobsPath(telegramId: string): string {
  return path.join('workspaces', telegramId, 'auto-promote.json');
}

export function loadJobs(telegramId: string): AutoPromoteJob[] {
  try {
    const p = jobsPath(telegramId);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8')) as AutoPromoteJob[];
  } catch { return []; }
}

function saveJobs(telegramId: string, jobs: AutoPromoteJob[]): void {
  const p = jobsPath(telegramId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(jobs, null, 2));
}

export function addJob(telegramId: string, sessionId: string, link: string, days: number): AutoPromoteJob {
  const jobs = loadJobs(telegramId);
  // Remove existing job for same session if any
  const filtered = jobs.filter((j) => j.sessionId !== sessionId);
  const now = Date.now();
  const job: AutoPromoteJob = {
    sessionId,
    telegramId,
    link,
    days,
    startedAt: now,
    endsAt: now + days * 24 * 60 * 60 * 1000,
    history: [],
  };
  filtered.push(job);
  saveJobs(telegramId, filtered);
  return job;
}

export function removeJob(telegramId: string, sessionId: string): void {
  const jobs = loadJobs(telegramId).filter((j) => j.sessionId !== sessionId);
  saveJobs(telegramId, jobs);
}

export function getJob(telegramId: string, sessionId: string): AutoPromoteJob | undefined {
  return loadJobs(telegramId).find((j) => j.sessionId === sessionId);
}

// ── Time helpers ──────────────────────────────────────────

/** Get current WAT time components */
function watNow(): { h: number; m: number; dayMs: number } {
  const utcMs = Date.now();
  const watMs = utcMs + WAT_OFFSET_MS;
  const d = new Date(watMs);
  return {
    h: d.getUTCHours(),
    m: d.getUTCMinutes(),
    dayMs: watMs,
  };
}

/** Ms until next occurrence of HH:MM WAT */
function msUntilWAT(targetH: number, targetM: number): number {
  const utcMs = Date.now();
  const watMs = utcMs + WAT_OFFSET_MS;
  const d = new Date(watMs);
  const todayTarget = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    targetH, targetM, 0, 0
  );
  let diff = todayTarget - watMs;
  if (diff <= 0) diff += 24 * 60 * 60 * 1000; // next day
  return diff;
}

// ── Run a single job ──────────────────────────────────────

async function runJob(job: AutoPromoteJob, slot: 'morning' | 'evening'): Promise<void> {
  const socket = getSocket(job.sessionId);
  if (!socket || isFrozen(job.sessionId)) {
    logger.warn('[AutoPromote] Session unavailable, skipping', { sessionId: job.sessionId, slot });
    return;
  }

  logger.info('[AutoPromote] Running', { sessionId: job.sessionId, slot, link: job.link });

  const result = { success: 0, failed: 0, skipped: 0 };
  try {
    const r = await cmdAllStatus(socket, job.sessionId, job.telegramId, job.link, {});
    result.success = r.success;
    result.failed = r.failed;
    result.skipped = r.skipped;
  } catch (err) {
    logger.error('[AutoPromote] Run failed', { sessionId: job.sessionId, err: String(err) });
    result.failed = 1;
  }

  // Record history
  const run: AutoPromoteRun = { at: Date.now(), slot, ...result };
  const jobs = loadJobs(job.telegramId);
  const idx = jobs.findIndex((j) => j.sessionId === job.sessionId);
  if (idx >= 0) {
    jobs[idx]!.history = [...(jobs[idx]!.history ?? []).slice(-29), run]; // keep last 30
    jobs[idx]!.lastRanAt = Date.now();
    saveJobs(job.telegramId, jobs);
  }
}

// ── Scheduler loop ────────────────────────────────────────

let schedulerStarted = false;

function scheduleSlot(targetH: number, targetM: number, slot: 'morning' | 'evening'): void {
  const delay = msUntilWAT(targetH, targetM);
  logger.info(`[AutoPromote] Next ${slot} run in ${Math.round(delay / 60000)}min`);

  setTimeout(async () => {
    // Run all active jobs for all users
    for (const telegramId of getAllUserIds()) {
      const jobs = loadJobs(telegramId).filter((j) => Date.now() < j.endsAt);
      for (const job of jobs) {
        await runJob(job, slot).catch(() => {});
      }
      // Prune expired jobs
      const active = loadJobs(telegramId).filter((j) => Date.now() < j.endsAt);
      saveJobs(telegramId, active);
    }
    // Schedule next occurrence (24h later)
    scheduleSlot(targetH, targetM, slot);
  }, delay);
}

export function startAutoPromoteScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  scheduleSlot(7, 0, 'morning');   // 7:00 AM WAT
  scheduleSlot(18, 0, 'evening');  // 6:00 PM WAT
  logger.info('[AutoPromote] Scheduler started (7:00 AM + 6:00 PM WAT)');
}

/** Run a job immediately (for testing or manual trigger) */
export async function runJobNow(telegramId: string, sessionId: string): Promise<AutoPromoteRun | null> {
  const job = getJob(telegramId, sessionId);
  if (!job) return null;
  const slot: 'morning' | 'evening' = watNow().h < 12 ? 'morning' : 'evening';
  await runJob(job, slot);
  return getJob(telegramId, sessionId)?.history.at(-1) ?? null;
}

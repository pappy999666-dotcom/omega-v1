// ============================================================
// WA-Bridge — Auto-Promote Scheduler
//
// ADMIN (max 4 links, evening only, no morning):
//   4:00 PM → link 0 | 4:30 PM → link 1 | 5:00 PM → link 2 | 5:30 PM → link 3
//
// PER-SESSION (max 24 links):
//   Morning: 6:00 AM WAT | Evening: 6:00 PM WAT
//   30 min max per link then next
// ============================================================

import type { AutoPromoteJob, AutoPromoteRun } from '../types/index.js';
import { getAllUserIds } from './workspace.js';
import { getSocket, isFrozen } from '../whatsapp/socket-manager.js';
import { cmdAllStatus, stopAllStatus } from '../whatsapp/commands/all-status.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

const WAT_OFFSET_MS = 60 * 60 * 1000;
const MAX_SESSION_LINKS = 24;
const MAX_ADMIN_LINKS = 4;
const MAX_MS_PER_LINK = 30 * 60 * 1000;

// ── Storage ───────────────────────────────────────────────

function sessionJobsPath(telegramId: string): string {
  return path.join('workspaces', telegramId, 'auto-promote.json');
}

function adminJobsPath(): string {
  return path.join('workspaces', '_admin', 'auto-promote.json');
}

export function loadJobs(telegramId: string): AutoPromoteJob[] {
  try {
    const p = sessionJobsPath(telegramId);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8')) as AutoPromoteJob[];
  } catch { return []; }
}

function saveJobs(telegramId: string, jobs: AutoPromoteJob[]): void {
  const p = sessionJobsPath(telegramId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(jobs, null, 2));
}

export function loadAdminJobs(): AutoPromoteJob[] {
  try {
    const p = adminJobsPath();
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8')) as AutoPromoteJob[];
  } catch { return []; }
}

function saveAdminJobs(jobs: AutoPromoteJob[]): void {
  const p = adminJobsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(jobs, null, 2));
}

// ── Per-session CRUD ──────────────────────────────────────

export function getSessionJob(telegramId: string, sessionId: string): AutoPromoteJob | undefined {
  return loadJobs(telegramId).find((j) => j.sessionId === sessionId);
}

export function addLink(telegramId: string, sessionId: string, link: string, days: number): AutoPromoteJob {
  const jobs = loadJobs(telegramId);
  const idx = jobs.findIndex((j) => j.sessionId === sessionId);
  const now = Date.now();
  if (idx >= 0) {
    const job = jobs[idx]!;
    if (!job.links.includes(link) && job.links.length < MAX_SESSION_LINKS) job.links.push(link);
    const newEnd = now + days * 86400000;
    if (newEnd > job.endsAt) job.endsAt = newEnd;
    saveJobs(telegramId, jobs);
    return job;
  }
  const job: AutoPromoteJob = {
    sessionId, telegramId, links: [link], days,
    startedAt: now, endsAt: now + days * 86400000, history: [],
  };
  jobs.push(job);
  saveJobs(telegramId, jobs);
  return job;
}

export function removeLink(telegramId: string, sessionId: string, linkIndex: number): void {
  const jobs = loadJobs(telegramId);
  const job = jobs.find((j) => j.sessionId === sessionId);
  if (!job) return;
  job.links.splice(linkIndex, 1);
  if (job.links.length === 0) saveJobs(telegramId, jobs.filter((j) => j.sessionId !== sessionId));
  else saveJobs(telegramId, jobs);
}

export function removeJob(telegramId: string, sessionId: string): void {
  saveJobs(telegramId, loadJobs(telegramId).filter((j) => j.sessionId !== sessionId));
}

// ── Admin CRUD ────────────────────────────────────────────

export function getAdminJob(): AutoPromoteJob | undefined {
  return loadAdminJobs()[0];
}

export function addAdminLink(telegramId: string, link: string, days: number): AutoPromoteJob {
  const jobs = loadAdminJobs();
  const now = Date.now();
  if (jobs.length === 0) {
    const job: AutoPromoteJob = {
      sessionId: '_admin', telegramId, links: [link], days,
      startedAt: now, endsAt: now + days * 86400000, history: [],
    };
    saveAdminJobs([job]);
    return job;
  }
  const job = jobs[0]!;
  if (!job.links.includes(link) && job.links.length < MAX_ADMIN_LINKS) job.links.push(link);
  const newEnd = now + days * 86400000;
  if (newEnd > job.endsAt) job.endsAt = newEnd;
  saveAdminJobs(jobs);
  return job;
}

export function removeAdminLink(linkIndex: number): void {
  const jobs = loadAdminJobs();
  if (!jobs[0]) return;
  jobs[0].links.splice(linkIndex, 1);
  if (jobs[0].links.length === 0) saveAdminJobs([]);
  else saveAdminJobs(jobs);
}

export function clearAdminJobs(): void { saveAdminJobs([]); }

// ── Time helpers ──────────────────────────────────────────

function msUntilWAT(h: number, m: number): number {
  const watMs = Date.now() + WAT_OFFSET_MS;
  const d = new Date(watMs);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, 0, 0);
  let diff = target - watMs;
  if (diff <= 0) diff += 86400000;
  return diff;
}

function watHour(): number {
  return new Date(Date.now() + WAT_OFFSET_MS).getUTCHours();
}

// ── Run one link (30-min cap) ─────────────────────────────

async function runLink(
  sessionId: string,
  telegramId: string,
  link: string,
  linkIndex: number,
  slot: 'morning' | 'evening',
  onDone: (run: AutoPromoteRun) => void
): Promise<void> {
  const socket = getSocket(sessionId);
  if (!socket || isFrozen(sessionId)) {
    logger.warn('[AutoPromote] Session unavailable', { sessionId, slot });
    return;
  }
  const start = Date.now();
  const result = { success: 0, failed: 0, skipped: 0 };
  const timer = setTimeout(() => stopAllStatus(sessionId), MAX_MS_PER_LINK);
  await cmdAllStatus(socket, sessionId, telegramId, link, {})
    .then((r) => { result.success = r.success; result.failed = r.failed; result.skipped = r.skipped; })
    .catch((err) => { logger.error('[AutoPromote] Error', { err: String(err) }); result.failed = 1; });
  clearTimeout(timer);
  stopAllStatus(sessionId);
  onDone({ at: Date.now(), slot, link, linkIndex, durationMs: Date.now() - start, ...result });
}

// ── Run all links for a session ───────────────────────────

async function runSessionSlot(job: AutoPromoteJob, slot: 'morning' | 'evening'): Promise<void> {
  for (let i = 0; i < job.links.length; i++) {
    await runLink(job.sessionId, job.telegramId, job.links[i]!, i, slot, (run) => {
      const jobs = loadJobs(job.telegramId);
      const idx = jobs.findIndex((j) => j.sessionId === job.sessionId);
      if (idx >= 0) {
        jobs[idx]!.history = [...(jobs[idx]!.history ?? []).slice(-59), run];
        jobs[idx]!.lastRanAt = Date.now();
        saveJobs(job.telegramId, jobs);
      }
    });
  }
}

// ── Run one admin slot (one link at a time) ───────────────

async function runAdminSlot(linkIndex: number): Promise<void> {
  const job = loadAdminJobs()[0];
  if (!job || linkIndex >= job.links.length || Date.now() > job.endsAt) return;

  const { getUserSockets } = await import('../whatsapp/socket-manager.js');
  const sessionId = getUserSockets(job.telegramId).find((sid) => !isFrozen(sid));
  if (!sessionId) { logger.warn('[AutoPromote] Admin: no session available', { linkIndex }); return; }

  await runLink(sessionId, job.telegramId, job.links[linkIndex]!, linkIndex, 'evening', (run) => {
    const jobs = loadAdminJobs();
    if (jobs[0]) {
      jobs[0].history = [...(jobs[0].history ?? []).slice(-19), run];
      jobs[0].lastRanAt = Date.now();
      saveAdminJobs(jobs);
    }
  });
}

// ── Scheduler ─────────────────────────────────────────────

let schedulerStarted = false;

// Admin: 4 fixed slots, one link each, no morning
const ADMIN_SLOTS: [number, number, number][] = [
  [16, 0, 0], [16, 30, 1], [17, 0, 2], [17, 30, 3],
];

function scheduleAdminSlot(h: number, m: number, linkIndex: number): void {
  const delay = msUntilWAT(h, m);
  logger.info(`[AutoPromote] Admin slot ${linkIndex} in ${Math.round(delay / 60000)}min`);
  setTimeout(async () => {
    await runAdminSlot(linkIndex).catch(() => {});
    scheduleAdminSlot(h, m, linkIndex);
  }, delay);
}

function scheduleSessionSlot(h: number, m: number, slot: 'morning' | 'evening'): void {
  const delay = msUntilWAT(h, m);
  logger.info(`[AutoPromote] Session ${slot} in ${Math.round(delay / 60000)}min`);
  setTimeout(async () => {
    for (const telegramId of getAllUserIds()) {
      const jobs = loadJobs(telegramId).filter((j) => Date.now() < j.endsAt && j.links.length > 0);
      for (const job of jobs) await runSessionSlot(job, slot).catch(() => {});
      saveJobs(telegramId, loadJobs(telegramId).filter((j) => Date.now() < j.endsAt));
    }
    scheduleSessionSlot(h, m, slot);
  }, delay);
}

export function startAutoPromoteScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  for (const [h, m, idx] of ADMIN_SLOTS) scheduleAdminSlot(h, m, idx);
  scheduleSessionSlot(6, 0, 'morning');
  scheduleSessionSlot(18, 0, 'evening');
  logger.info('[AutoPromote] Admin: 4:00-5:30 PM WAT | Sessions: 6:00 AM + 6:00 PM WAT');
}

export async function runJobNow(telegramId: string, sessionId: string): Promise<void> {
  const job = getSessionJob(telegramId, sessionId);
  if (!job) return;
  await runSessionSlot(job, watHour() < 12 ? 'morning' : 'evening');
}

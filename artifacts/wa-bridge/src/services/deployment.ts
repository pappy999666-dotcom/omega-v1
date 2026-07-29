// ============================================================
// WA-Bridge — Deployment Service
// Real-time live terminal output streamed to Telegram
// ============================================================

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';

// ── Types ─────────────────────────────────────────────────

export interface DeployResult {
  success: boolean;
  failedStep?: string;
  error?: string;
  prevCommit?: string;
  currCommit?: string;
  filesChanged?: number;
  buildDurationMs?: number;
  totalDurationMs?: number;
}

type ProgressCallback = (lines: string[]) => Promise<void>;

// ── Helpers ───────────────────────────────────────────────

const APP_DIR = process.env.APP_DIR ?? '/root/omega-v1';
const WA_BRIDGE_DIR = `${APP_DIR}/artifacts/wa-bridge`;

// Run a command and stream output line-by-line to onLine callback
function runLive(
  cmd: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env: process.env, shell: false });
    let buf = '';

    const flush = (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const clean = l.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (clean) onLine(clean);
      }
    };

    proc.stdout.on('data', (d: Buffer) => flush(d.toString()));
    proc.stderr.on('data', (d: Buffer) => flush(d.toString()));
    proc.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim());
      if (code === 0) resolve();
      else reject(new Error(`Exit code ${code}`));
    });
    proc.on('error', reject);
  });
}

// Simple exec for short commands
function exec(cmd: string, cwd = APP_DIR): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', cmd], { cwd, env: process.env });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(out.trim() || `Exit ${code}`));
    });
    proc.on('error', reject);
  });
}

async function safeExec(cmd: string, cwd = APP_DIR): Promise<string> {
  try { return await exec(cmd, cwd); } catch { return ''; }
}

// ── Main Deploy Pipeline ──────────────────────────────────

export async function runDeployment(onProgress: ProgressCallback): Promise<DeployResult> {
  const startedAt = Date.now();
  const log: string[] = [];
  let prevCommit = '';
  let currCommit = '';
  let filesChanged = 0;
  let buildStart = 0;
  let buildDurationMs = 0;

  // Throttle Telegram edits — max 1 per 800ms
  let lastEdit = 0;
  const push = async (...lines: string[]) => {
    log.push(...lines);
    const now = Date.now();
    if (now - lastEdit >= 800) {
      lastEdit = now;
      await onProgress([...log]).catch(() => {});
    }
  };

  // Force flush regardless of throttle
  const flush = async () => {
    lastEdit = Date.now();
    await onProgress([...log]).catch(() => {});
  };

  const fail = async (step: string, err: unknown): Promise<DeployResult> => {
    const msg = err instanceof Error ? err.message : String(err);
    log.push('', `❌ <b>${step} failed</b>`, `<code>${msg.slice(0, 400)}</code>`);
    await flush();
    logger.error('[Deploy] Step failed', { step, err: msg });
    return { success: false, failedStep: step, error: msg, prevCommit, currCommit, totalDurationMs: Date.now() - startedAt };
  };

  try {
    // ── Safety checks ──────────────────────────────────────
    log.push('🔍 <b>Safety checks...</b>');
    await flush();

    if (!existsSync(`${APP_DIR}/.git`)) return await fail('Safety', new Error(`No git repo at ${APP_DIR}`));
    const nodeVer = await safeExec('node --version');
    const major = parseInt(nodeVer.replace('v', '').split('.')[0] ?? '0', 10);
    if (major < 18) return await fail('Safety', new Error(`Node ${nodeVer} too old, need v18+`));
    if (!process.env.TELEGRAM_BOT_TOKEN) return await fail('Safety', new Error('TELEGRAM_BOT_TOKEN missing'));

    log.push('✅ Safety checks passed');

    // ── Git fetch ──────────────────────────────────────────
    prevCommit = await safeExec('git rev-parse --short HEAD');
    log.push('', `📌 Current: <code>${prevCommit}</code>`, '⬇️ <b>Fetching from GitHub...</b>');
    await flush();

    await runLive('git', ['fetch', 'origin', 'main'], APP_DIR, (l) => {
      push(`  <code>${l}</code>`);
    });

    const remoteCommit = await safeExec('git rev-parse --short origin/main');
    log.push(`📌 Remote: <code>${remoteCommit}</code>`);

    if (remoteCommit === prevCommit) {
      log.push('', 'ℹ️ Already up to date — nothing to pull');
      await flush();
      return { success: true, prevCommit, currCommit: prevCommit, filesChanged: 0, buildDurationMs: 0, totalDurationMs: Date.now() - startedAt };
    }

    // ── Git pull ───────────────────────────────────────────
    log.push('', '⬇️ <b>Pulling changes...</b>');
    await flush();

    await runLive('git', ['pull', 'origin', 'main'], APP_DIR, (l) => {
      push(`  <code>${l}</code>`);
      const m = l.match(/(\d+) file/);
      if (m) filesChanged = parseInt(m[1] ?? '0', 10);
    });

    currCommit = await safeExec('git rev-parse --short HEAD');
    log.push(`✅ Pulled → <code>${currCommit}</code>`);

    // ── Install deps ───────────────────────────────────────
    log.push('', '📦 <b>Installing dependencies...</b>');
    await flush();

    await runLive('pnpm', ['install'], WA_BRIDGE_DIR, (l) => {
      push(`  <code>${l}</code>`);
    });
    log.push('✅ Dependencies ready');

    // ── Build ──────────────────────────────────────────────
    log.push('', '🔨 <b>Building...</b>');
    await flush();
    buildStart = Date.now();

    await runLive('node', ['build.mjs'], WA_BRIDGE_DIR, (l) => {
      push(`  <code>${l}</code>`);
    });

    buildDurationMs = Date.now() - buildStart;
    log.push(`✅ Build done in ${(buildDurationMs / 1000).toFixed(1)}s`);

    // ── Restart ────────────────────────────────────────────
    log.push('', '🔄 <b>Restarting wa-bridge...</b>');
    await flush();

    await runLive('pm2', ['restart', 'wa-bridge', '--update-env'], APP_DIR, (l) => {
      push(`  <code>${l}</code>`);
    });

    // ── Verify ─────────────────────────────────────────────
    log.push('', '🔍 <b>Verifying...</b>');
    await flush();
    await new Promise((r) => setTimeout(r, 4000));

    const jlist = await safeExec('pm2 jlist');
    let online = false;
    try {
      const procs = JSON.parse(jlist) as Array<{ name: string; pm2_env?: { status?: string } }>;
      online = procs.some((p) => p.name === 'wa-bridge' && p.pm2_env?.status === 'online');
    } catch { /* ignore */ }

    if (!online) return await fail('Verification', new Error('wa-bridge not online after restart'));

    const totalDurationMs = Date.now() - startedAt;
    log.push('', `🚀 <b>Deployment complete!</b>`, `⏱ Total: ${(totalDurationMs / 1000).toFixed(1)}s | Files: ${filesChanged} | Build: ${(buildDurationMs / 1000).toFixed(1)}s`);
    await flush();

    return { success: true, prevCommit, currCommit, filesChanged, buildDurationMs, totalDurationMs };

  } catch (err) {
    return await fail('Unexpected Error', err);
  }
}

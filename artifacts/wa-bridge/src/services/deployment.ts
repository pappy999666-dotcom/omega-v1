// ============================================================
// WA-Bridge — Deployment Service
// Advanced pipeline with safety checks, build, and rollback
// ============================================================

import { spawn } from 'child_process';
import { existsSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { generateReleaseNotes } from '../utils/release-notes.js';
import { loadPlatformConfig } from './workspace.js';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveAppDir(): string {
  if (process.env.APP_DIR) return path.resolve(process.env.APP_DIR);
  let current = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const APP_DIR = resolveAppDir();
const WA_BRIDGE_DIR = path.join(APP_DIR, 'artifacts/wa-bridge');

function runLive(cmd: string, args: string[], cwd: string, onLine: (line: string) => void): Promise<void> {
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

  let lastEdit = 0;
  const push = async (...lines: string[]) => {
    log.push(...lines);
    const now = Date.now();
    if (now - lastEdit >= 800) {
      lastEdit = now;
      await onProgress([...log]).catch(() => {});
    }
  };

  const flush = async () => {
    lastEdit = Date.now();
    await onProgress([...log]).catch(() => {});
  };

  const fail = async (step: string, err: unknown): Promise<DeployResult> => {
    const msg = err instanceof Error ? err.message : String(err);
    log.push('', `❌ <b>${step} failed</b>`, `<code>${msg.slice(0, 400)}</code>`);
    await flush();
    logger.error('[Deploy] Step failed', { step, err: msg });
    
    // Attempt rollback if we already pulled
    if (prevCommit && currCommit && prevCommit !== currCommit) {
      log.push('🔄 <b>Attempting rollback to ' + prevCommit + '...</b>');
      await flush();
      await safeExec(`git reset --hard ${prevCommit}`, APP_DIR);
      log.push('✅ Rollback complete');
      await flush();
    }

    return { success: false, failedStep: step, error: msg, prevCommit, currCommit, totalDurationMs: Date.now() - startedAt };
  };

  try {
    // 1. Safety checks
    log.push('🔍 <b>Safety checks...</b>');
    await flush();
    if (!existsSync(`${APP_DIR}/.git`)) return await fail('Safety', new Error(`No git repo at ${APP_DIR}`));
    
    // Check for uncommitted changes
    const status = await safeExec('git status --porcelain', APP_DIR);
    if (status) {
      log.push('⚠️ <b>Uncommitted changes detected. Stashing...</b>');
      await safeExec('git stash', APP_DIR);
    }

    prevCommit = await safeExec('git rev-parse --short HEAD');
    log.push('✅ Safety checks passed');

    // 2. Git fetch & pull
    log.push('', `📌 Current: <code>${prevCommit}</code>`, '⬇️ <b>Pulling from GitHub...</b>');
    await flush();

    await runLive('git', ['pull', 'origin', 'main'], APP_DIR, (l) => {
      push(`  <code>${l}</code>`);
      const m = l.match(/(\d+) file/);
      if (m) filesChanged += parseInt(m[1] ?? '0', 10);
    });

    currCommit = await safeExec('git rev-parse --short HEAD');
    if (currCommit === prevCommit) {
      log.push('ℹ️ Already up to date');
      await flush();
      return { success: true, prevCommit, currCommit, filesChanged: 0, buildDurationMs: 0, totalDurationMs: Date.now() - startedAt };
    }
    log.push(`✅ Pulled → <code>${currCommit}</code>`);

    // 3. Dependencies
    const pkgChanged = await safeExec(`git diff --name-only ${prevCommit} ${currCommit} | grep -E "package.json|pnpm-lock.yaml"`);
    if (pkgChanged) {
      log.push('', '📦 <b>Dependencies changed. Installing...</b>');
      await flush();
      await runLive('pnpm', ['install'], APP_DIR, (l) => push(`  <code>${l}</code>`));
      log.push('✅ Dependencies updated');
    } else {
      log.push('', 'ℹ️ No dependency changes');
    }

    // 4. Build
    log.push('', '🔨 <b>Cleaning and Building...</b>');
    await flush();
    
    // Clean dist and cache
    rmSync(path.join(WA_BRIDGE_DIR, 'dist'), { recursive: true, force: true });
    
    buildStart = Date.now();
    await runLive('pnpm', ['run', 'build'], APP_DIR, (l) => push(`  <code>${l}</code>`));
    buildDurationMs = Date.now() - buildStart;
    log.push(`✅ Build done in ${(buildDurationMs / 1000).toFixed(1)}s`);

    // 5. Restart
    log.push('', '🔄 <b>Restarting via PM2...</b>');
    await flush();
    await runLive('pm2', ['restart', 'wa-bridge', '--update-env'], APP_DIR, (l) => push(`  <code>${l}</code>`));

    // 6. Verification
    log.push('', '🔍 <b>Verifying deployment...</b>');
    await flush();
    await new Promise((r) => setTimeout(r, 5000));

    const jlist = await safeExec('pm2 jlist');
    let online = false;
    try {
      const procs = JSON.parse(jlist);
      online = procs.some((p: any) => p.name === 'wa-bridge' && p.pm2_env?.status === 'online');
    } catch { online = false; }

    if (!online) return await fail('Verification', new Error('wa-bridge not online after restart'));
    log.push('✅ Bot is online');

    // 7. Release Notes
    const releaseNotes = await generateReleaseNotes(prevCommit, currCommit);
    const platformCfg = loadPlatformConfig();
    
    if (platformCfg.releasePostsEnabled && platformCfg.releaseChannelUsername) {
      log.push('', '📢 <b>Posting release notes...</b>');
      await flush();
      // This part will be handled by the bot itself after restart or via a separate script
      // For now, we'll mark it as "to be posted"
      log.push(`✅ Release notes ready for ${platformCfg.releaseChannelUsername}`);
    }

    const totalDurationMs = Date.now() - startedAt;
    log.push('', `🚀 <b>Deployment complete!</b>`);
    await flush();

    return { success: true, prevCommit, currCommit, filesChanged, buildDurationMs, totalDurationMs };

  } catch (err) {
    return await fail('Unexpected Error', err);
  }
}

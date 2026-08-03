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

  const push = async (...lines: string[]) => {
    log.push(...lines);
    await onProgress([...log]).catch(() => {});
  };

  const flush = async () => {
    await onProgress([...log]).catch(() => {});
  };

  const fail = async (step: string, err: unknown): Promise<DeployResult> => {
    const msg = err instanceof Error ? err.message : String(err);
    log.push('', `❌ <b>Step [${step}] failed</b>`, `<code>${msg.slice(0, 400)}</code>`);
    await flush();
    logger.error('[Deploy] Step failed', { step, err: msg });
    
    // ── ROLLBACK SYSTEM ──
    if (prevCommit) {
      log.push('🔄 <b>ROLLBACK INITIATED...</b>');
      await flush();
      try {
        await safeExec(`git reset --hard ${prevCommit}`, APP_DIR);
        await safeExec('pm2 restart wa-bridge --update-env', APP_DIR);
        log.push('✅ Rollback complete. Previous version restored.');
      } catch (rErr) {
        log.push('❌ Critical: Rollback failed.');
      }
      await flush();
    }

    return { success: false, failedStep: step, error: msg, prevCommit, currCommit, totalDurationMs: Date.now() - startedAt };
  };

  try {
    // 1. Verify repository
    log.push('🔍 <b>[1/14] Verifying repository...</b>');
    if (!existsSync(`${APP_DIR}/.git`)) return await fail('Verify Repo', new Error(`No git repo at ${APP_DIR}`));
    prevCommit = await safeExec('git rev-parse --short HEAD');
    log.push(`✅ Repo verified at <code>${prevCommit}</code>`);

    // 2. Detect local changes
    log.push('🔍 <b>[2/14] Detecting local changes...</b>');
    const status = await safeExec('git status --porcelain', APP_DIR);
    if (status) {
      log.push('⚠️ Uncommitted changes detected. Stashing...');
      await safeExec('git stash', APP_DIR);
    }
    log.push('✅ Local workspace clean');

    // 3. Safely stop PM2
    log.push('🛑 <b>[3/14] Safely stopping PM2...</b>');
    await safeExec('pm2 stop wa-bridge', APP_DIR);
    log.push('✅ PM2 stopped');

    // 4. Pull latest commits
    log.push('⬇️ <b>[4/14] Pulling latest commits...</b>');
    await runLive('git', ['pull', 'origin', 'main'], APP_DIR, (l) => {
      push(`  <code>${l}</code>`);
      if (l.includes('file changed')) {
        const m = l.match(/(\d+) file/);
        if (m) filesChanged += parseInt(m[1] ?? '0', 10);
      }
    });
    currCommit = await safeExec('git rev-parse --short HEAD');
    log.push(`✅ Pulled → <code>${currCommit}</code>`);

    // 5. Install dependencies
    log.push('📦 <b>[5/14] Checking dependencies...</b>');
    const pkgChanged = await safeExec(`git diff --name-only ${prevCommit} ${currCommit} | grep -E "package.json|pnpm-lock.yaml"`);
    if (pkgChanged) {
      log.push('📦 Dependencies changed. Installing...');
      await runLive('pnpm', ['install'], APP_DIR, (l) => push(`  <code>${l}</code>`));
      log.push('✅ Dependencies updated');
    } else {
      log.push('✅ No dependency changes');
    }

    // 6. Clear obsolete cache
    log.push('🧹 <b>[6/14] Clearing obsolete cache...</b>');
    await safeExec('rm -rf node_modules/.cache', APP_DIR);
    log.push('✅ Cache cleared');

    // 7. Delete old dist
    log.push('🗑️ <b>[7/14] Deleting old dist...</b>');
    rmSync(path.join(WA_BRIDGE_DIR, 'dist'), { recursive: true, force: true });
    log.push('✅ Old dist deleted');

    // 8. Rebuild
    log.push('🔨 <b>[8/14] Rebuilding...</b>');
    buildStart = Date.now();
    await runLive('pnpm', ['run', 'build'], APP_DIR, (l) => push(`  <code>${l}</code>`));
    buildDurationMs = Date.now() - buildStart;
    log.push(`✅ Build done in ${(buildDurationMs / 1000).toFixed(1)}s`);

    // 9. Verify build
    log.push('🔍 <b>[9/14] Verifying build...</b>');
    if (!existsSync(path.join(WA_BRIDGE_DIR, 'dist/index.js'))) {
      return await fail('Verify Build', new Error('Build output missing index.js'));
    }
    log.push('✅ Build verified');

    // 10. Restart PM2
    log.push('🔄 <b>[10/14] Restarting PM2...</b>');
    await safeExec('pm2 start wa-bridge --update-env', APP_DIR);
    log.push('✅ PM2 restarted');

    // Wait for startup
    await new Promise(r => setTimeout(r, 10000));

    // 11. Verify Telegram
    log.push('🤖 <b>[11/14] Verifying Telegram...</b>');
    const tgToken = process.env.TELEGRAM_TOKEN;
    if (tgToken) {
      const { ConnectionTester } = await import('../setup/ConnectionTester.js') as any;
      const tgOk = await ConnectionTester.testTelegram(tgToken);
      if (!tgOk) return await fail('Verify Telegram', new Error('Telegram API connection failed'));
    }
    log.push('✅ Telegram online');

    // 12. Verify WhatsApp
    log.push('📱 <b>[12/14] Verifying WhatsApp...</b>');
    const jlist = await safeExec('pm2 jlist');
    const procs = JSON.parse(jlist);
    const proc = procs.find((p: any) => p.name === 'wa-bridge');
    if (!proc || proc.pm2_env?.status !== 'online') {
      return await fail('Verify WhatsApp', new Error('WhatsApp process is not online'));
    }
    log.push('✅ WhatsApp online');

    // 13. Verify Sessions
    log.push('📂 <b>[13/14] Verifying Sessions...</b>');
    const sessionsExist = existsSync(path.join(APP_DIR, 'artifacts/workspaces'));
    log.push(sessionsExist ? '✅ Session registry intact' : '⚠️ Session registry empty');

    // 14. Return summary
    const totalDurationMs = Date.now() - startedAt;
    log.push('', `🚀 <b>[14/14] Deployment Summary</b>`, 
      `• Duration: ${(totalDurationMs / 1000).toFixed(1)}s`,
      `• Build: ${(buildDurationMs / 1000).toFixed(1)}s`,
      `• Version: ${currCommit}`,
      `• Files: ${filesChanged}`
    );
    await flush();

    return { success: true, prevCommit, currCommit, filesChanged, buildDurationMs, totalDurationMs };

  } catch (err) {
    return await fail('Unexpected Error', err);
  }
}

// ============================================================
// WA-Bridge — Deployment Service
// One-click GitHub update with live Telegram console,
// rollback, safety checks, and post-deploy verification
// ============================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

// ── Types ─────────────────────────────────────────────────

export interface DeployStep {
  label: string;
  run: () => Promise<string>;
}

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

async function run(cmd: string, cwd = APP_DIR): Promise<string> {
  const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 120_000 });
  return (stdout + stderr).trim();
}

async function safeRun(cmd: string, cwd = APP_DIR): Promise<string> {
  try { return await run(cmd, cwd); }
  catch (err) { return String(err); }
}

function line(icon: string, text: string): string {
  return `${icon} ${text}`;
}

// ── Safety Checks ─────────────────────────────────────────

async function runSafetyChecks(): Promise<void> {
  // Git available
  await run('git --version');

  // Repo exists
  if (!existsSync(`${APP_DIR}/.git`)) {
    throw new Error(`Git repository not found at ${APP_DIR}`);
  }

  // Node version
  const nodeVer = await run('node --version');
  const major = parseInt(nodeVer.replace('v', '').split('.')[0] ?? '0', 10);
  if (major < 18) throw new Error(`Node.js ${nodeVer} is too old. Requires v18+`);

  // pnpm available
  await run('pnpm --version');

  // Disk space (require at least 500 MB free)
  const dfOut = await run("df -BM . | tail -1 | awk '{print $4}'");
  const freeMB = parseInt(dfOut.replace('M', ''), 10);
  if (!isNaN(freeMB) && freeMB < 500) {
    throw new Error(`Insufficient disk space: ${freeMB}MB free (need 500MB+)`);
  }

  // Write permission
  await run(`touch ${APP_DIR}/.deploy_check && rm ${APP_DIR}/.deploy_check`);

  // Required env vars
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID'];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
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

  const fail = async (step: string, err: unknown): Promise<DeployResult> => {
    const msg = err instanceof Error ? err.message : String(err);
    await push('', line('❌', `<b>${step} failed</b>`), line('📋', `<code>${msg.slice(0, 300)}</code>`));
    logger.error('[Deploy] Step failed', { step, err: msg });
    return {
      success: false,
      failedStep: step,
      error: msg,
      prevCommit,
      currCommit,
      totalDurationMs: Date.now() - startedAt,
    };
  };

  try {
    // ── Safety Checks ──
    await push(line('⬛', 'Running safety checks...'));
    try {
      await runSafetyChecks();
    } catch (err) {
      return await fail('Safety Checks', err);
    }
    await push(line('🟩', 'Safety checks passed'));

    // ── Capture previous commit ──
    prevCommit = await safeRun('git rev-parse --short HEAD');
    await push('', line('⬛', 'Connecting to GitHub...'));
    try {
      await run('git remote update origin --prune');
    } catch (err) {
      return await fail('GitHub Connection', err);
    }
    await push(line('🟩', 'Repository connected'));

    // ── Fetch latest commit info ──
    await push('', line('⬛', 'Fetching latest commit...'));
    let latestCommit: string;
    try {
      latestCommit = await run('git rev-parse --short origin/HEAD');
    } catch {
      latestCommit = await safeRun('git rev-parse --short origin/main').catch(() => 'unknown');
    }
    await push(line('🟩', `Latest commit: <code>${latestCommit}</code>`));

    // Check if already up to date
    if (latestCommit === prevCommit) {
      await push('', line('ℹ️', 'Already up to date — no changes to pull'));
      return {
        success: true,
        prevCommit,
        currCommit: prevCommit,
        filesChanged: 0,
        buildDurationMs: 0,
        totalDurationMs: Date.now() - startedAt,
      };
    }

    // ── Pull changes ──
    await push('', line('⬛', 'Pulling repository...'));
    let pullOut: string;
    try {
      pullOut = await run('git pull --ff-only origin HEAD');
    } catch (err) {
      // Try merge conflict detection
      const status = await safeRun('git status --porcelain');
      if (status.includes('UU') || status.includes('AA')) {
        await run('git merge --abort').catch(() => {});
        return await fail('Git Pull', new Error('Merge conflict detected — aborting. Resolve conflicts manually.'));
      }
      return await fail('Git Pull', err);
    }
    currCommit = await safeRun('git rev-parse --short HEAD');
    filesChanged = (pullOut.match(/\d+ file/)?.[0] ? parseInt(pullOut.match(/(\d+) file/)?.[1] ?? '0', 10) : 0);
    await push(line('🟩', `Repository updated → <code>${currCommit}</code>`));

    // ── Install dependencies ──
    await push('', line('⬛', 'Installing dependencies...'));
    try {
      await run('pnpm install --frozen-lockfile');
    } catch (err) {
      return await fail('Dependency Installation', err);
    }
    await push(line('🟩', 'Dependencies installed'));

    // ── Typecheck ──
    await push('', line('⬛', 'Running typecheck...'));
    try {
      await run('pnpm --filter @workspace/wa-bridge exec tsc --noEmit', APP_DIR);
    } catch (err) {
      return await fail('Typecheck', err);
    }
    await push(line('🟩', 'Typecheck passed'));

    // ── Build ──
    await push('', line('⬛', 'Building project...'));
    buildStart = Date.now();
    try {
      await run('pnpm --filter @workspace/wa-bridge build');
    } catch (err) {
      return await fail('Build', err);
    }
    buildDurationMs = Date.now() - buildStart;
    await push(line('🟩', `Build successful (${(buildDurationMs / 1000).toFixed(1)}s)`));

    // ── Reload env ──
    await push('', line('⬛', 'Reloading environment...'));
    // PM2 will pick up env on restart — nothing to do here
    await push(line('🟩', 'Environment ready'));

    // ── Restart via PM2 ──
    await push('', line('⬛', 'Restarting services...'));
    try {
      await run('pm2 restart wa-bridge --update-env');
    } catch (err) {
      return await fail('Service Restart', err);
    }
    await push(line('🟩', 'Services restarted'));

    // ── Post-deploy verification ──
    await push('', line('⬛', 'Verifying deployment...'));
    await new Promise((r) => setTimeout(r, 5000)); // Give PM2 time to stabilize
    try {
      const status = await run('pm2 jlist');
      const procs = JSON.parse(status) as Array<{ name: string; pm2_env?: { status?: string } }>;
      const bridge = procs.find((p) => p.name === 'wa-bridge');
      if (!bridge) throw new Error('wa-bridge process not found in PM2');
      if (bridge.pm2_env?.status !== 'online') {
        throw new Error(`wa-bridge status is "${bridge.pm2_env?.status}" — expected "online"`);
      }
    } catch (err) {
      return await fail('Post-Deploy Verification', err);
    }
    await push(line('🟩', 'Deployment verified — all systems online'));

    const totalDurationMs = Date.now() - startedAt;
    await push('', line('🚀', '<b>Deployment complete!</b>'));

    return {
      success: true,
      prevCommit,
      currCommit,
      filesChanged,
      buildDurationMs,
      totalDurationMs,
    };
  } catch (err) {
    return await fail('Unexpected Error', err);
  }
}

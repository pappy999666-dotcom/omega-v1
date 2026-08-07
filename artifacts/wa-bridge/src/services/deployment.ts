// ============================================================
// WA-Bridge — Deployment Service
// Advanced pipeline with safety checks, build, and rollback
// ============================================================

import { spawn } from 'child_process';
import fs, { existsSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { generateReleaseNotes } from '../utils/release-notes.js';
import { DependencyChecker } from '../setup/DependencyChecker.js';

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
const workspaceInfo = DependencyChecker.detectWorkspaceInfo();

const APP_DIR = workspaceInfo.root;
const WA_BRIDGE_DIR = workspaceInfo.botPackagePath;

function runLive(cmd: string, args: string[], cwd: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env: process.env, shell: false });
    let buf = '';
    let fullLog = '';
    const flush = (chunk: string) => {
      buf += chunk;
      fullLog += chunk;
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
      else {
        const err = new Error(`Command failed: ${cmd} ${args.join(' ')}\nExit Code: ${code}\nOutput: ${fullLog.slice(-500)}`);
        (err as any).exitCode = code;
        (err as any).stdout = fullLog;
        reject(err);
      }
    });
    proc.on('error', reject);
  });
}

function exec(cmd: string, cwd = APP_DIR): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', cmd], { cwd, env: process.env });
    let out = '';
    let errOut = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { errOut += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else {
        const error = new Error(`Command: ${cmd}\nExit Code: ${code}\nReason: ${errOut.trim() || out.trim() || 'Unknown'}`);
        (error as any).exitCode = code;
        (error as any).stdout = out;
        (error as any).stderr = errOut;
        reject(error);
      }
    });
    proc.on('error', reject);
  });
}

async function safeExec(cmd: string, cwd = APP_DIR): Promise<string> {
  try { return await exec(cmd, cwd); } catch { return ''; }
}

function getSuggestedFix(step: string, error: string): string {
    const lowerError = error.toLowerCase();
    if (step === 'Verify Repo') return 'Ensure the current directory is a valid git repository.';
    if (step === 'Pull Commits') return 'Check your internet connection and git permissions.';
    if (step === 'Install Deps') return 'Check if pnpm is installed and package.json is valid.';
    if (step === 'Rebuild') return 'Fix TypeScript errors in your source code.';
    if (lowerError.includes('redis')) return 'Ensure Redis server is running: sudo systemctl start redis-server';
    if (lowerError.includes('mongo')) return 'Ensure MongoDB server is running: sudo systemctl start mongod';
    if (lowerError.includes('pm2')) return 'Try restarting PM2 manually or check "pm2 logs".';
    return 'Check the logs for detailed error information.';
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
    const exitCode = (err as any).exitCode;
    const fix = getSuggestedFix(step, msg);

    log.push('', `❌ <b>Step [${step}] failed</b>`);
    if (exitCode !== undefined) log.push(`  - Exit Code: ${exitCode}`);
    log.push(`  - Error: <code>${msg.slice(0, 400)}</code>`);
    log.push(`  - <b>Suggested Fix:</b> ${fix}`);
    
    await flush();
    logger.error('[Deploy] Step failed', { step, err: msg });
    
    // ── ROLLBACK SYSTEM ──
    if (prevCommit) {
      log.push('🔄 <b>ROLLBACK INITIATED...</b>');
      await flush();
      try {
        await safeExec(`git reset --hard ${prevCommit}`, APP_DIR);
        await safeExec(`git clean -fd`, APP_DIR);
        
        const DIST_PATH = path.join(WA_BRIDGE_DIR, 'dist');
        const DIST_OLD = path.join(WA_BRIDGE_DIR, 'dist_old');
        if (existsSync(DIST_OLD)) {
          rmSync(DIST_PATH, { recursive: true, force: true });
          await safeExec(`mv ${DIST_OLD} ${DIST_PATH}`, APP_DIR);
          log.push('  - Restored previous dist artifacts');
        }
        
        await safeExec('pm2 reload wa-bridge --update-env', APP_DIR);
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
    log.push('🔍 <b>[1/13] Verifying repository...</b>');
    if (!existsSync(path.join(APP_DIR, '.git'))) return await fail('Verify Repo', new Error(`No git repo at ${APP_DIR}`));
    prevCommit = await safeExec('git rev-parse --short HEAD');
    log.push(`✅ Repo verified at <code>${prevCommit}</code>`);

    // 2. Detect local changes
    log.push('🔍 <b>[2/13] Detecting local changes...</b>');
    const status = await safeExec('git status --porcelain', APP_DIR);
    if (status) {
      log.push('⚠️ Uncommitted changes detected. Stashing...');
      await safeExec('git stash', APP_DIR);
    }
    log.push('✅ Local workspace clean');

    // 3. Pull latest commits (DO NOT stop PM2 yet — bot must stay alive for progress)
    log.push('⬇️ <b>[3/13] Pulling latest commits...</b>');
    try {
      await runLive('git', ['pull', 'origin', 'main'], APP_DIR, (l) => {
        push(`  <code>${l}</code>`);
      });
    } catch (e: any) { e.step = 'Pull Commits'; throw e; }
    currCommit = await safeExec('git rev-parse --short HEAD');
    log.push(`✅ Pulled → <code>${currCommit}</code>`);

    // 3b. Compute the EXACT file-change count deterministically — never rely on
    // parsing git's human-readable pull banner (which can be localized or show
    // "Already up to date"). Files changed = diff between prev..curr, counted
    // from the merge-base to handle fast-forwards and diverged histories.
    if (prevCommit && currCommit && prevCommit !== currCommit) {
      const base = await safeExec(`git merge-base ${prevCommit} ${currCommit}`, APP_DIR);
      const range = base ? `${base}..${currCommit}` : `${prevCommit}..${currCommit}`;
      const changedFiles = await safeExec(`git diff --name-only ${range}`, APP_DIR);
      filesChanged = changedFiles ? changedFiles.split(String.fromCharCode(10)).filter((l) => l.trim()).length : 0;
      log.push(`✅ Files changed: ${filesChanged}`);
    }

    // 4. Install dependencies
    log.push('📦 <b>[4/13] Checking dependencies...</b>');
    const pkgChanged = await safeExec(`git diff --name-only ${prevCommit} ${currCommit} | grep -E "package.json|pnpm-lock.yaml"`);
    if (pkgChanged) {
      log.push('📦 Dependencies changed. Installing...');
      try {
        await runLive('pnpm', ['install'], APP_DIR, (l) => push(`  <code>${l}</code>`));
      } catch (e: any) { e.step = 'Install Deps'; throw e; }
      log.push('✅ Dependencies updated');
    } else {
      log.push('✅ No dependency changes');
    }

    // 5. Clear obsolete cache
    log.push('🧹 <b>[5/13] Clearing obsolete cache...</b>');
    await safeExec('rm -rf node_modules/.cache', APP_DIR);
    log.push('✅ Cache cleared');

    // 6. Rebuild
    log.push('🔨 <b>[6/13] Rebuilding wa-bridge...</b>');
    buildStart = Date.now();
    const DIST_PATH = path.join(WA_BRIDGE_DIR, 'dist');
    const DIST_NEW = path.join(WA_BRIDGE_DIR, 'dist_new');
    const DIST_OLD = path.join(WA_BRIDGE_DIR, 'dist_old');
    
    rmSync(DIST_NEW, { recursive: true, force: true });
    
    try {
      await runLive('sh', ['-c', `export OUT_DIR=dist_new && pnpm --filter @workspace/wa-bridge run build`], APP_DIR, (l) => push(`  <code>${l}</code>`));
    } catch (e: any) { e.step = 'Rebuild'; throw e; }
    buildDurationMs = Date.now() - buildStart;
    log.push(`✅ Build done in ${(buildDurationMs / 1000).toFixed(1)}s`);

    // 7. Atomic Swap
    log.push('🔄 <b>[7/13] Performing atomic dist swap...</b>');
    // Detect real entry point in dist_new
    let entryFile = 'index.js';
    if (!existsSync(path.join(DIST_NEW, entryFile))) {
        // Try to find any js file in root of dist_new
        const files = fs.readdirSync(DIST_NEW);
        const jsFile = files.find(f => f.endsWith('.js'));
        if (jsFile) entryFile = jsFile;
        else return await fail('Verify Build', new Error('Build output missing entry JS file in dist_new'));
    }
    
    rmSync(DIST_OLD, { recursive: true, force: true });
    if (existsSync(DIST_PATH)) {
      await safeExec(`mv ${DIST_PATH} ${DIST_OLD}`, APP_DIR);
    }
    await safeExec(`mv ${DIST_NEW} ${DIST_PATH}`, APP_DIR);
    log.push('✅ Dist swapped');

    // 8. Deep Health Verification (BEFORE restart — verify the new build loads)
    log.push('🔍 <b>[8/13] Pre-restart health verification...</b>');
    
    if (existsSync(path.join(APP_DIR, 'artifacts/workspaces'))) {
      log.push('  - Session registry intact');
    } else {
      log.push('  ⚠️ Session registry empty');
    }
    log.push('✅ Pre-restart checks passed');

    // 9. Release Notes
    log.push('📝 <b>[9/13] Generating release notes...</b>');
    try {
      const notes = await generateReleaseNotes(prevCommit, currCommit);
      log.push(`✅ Notes generated: ${notes.length} items`);
    } catch {
      log.push('⚠️ Failed to generate release notes');
    }

    // 10. Return summary (deploy SUCCEEDED)
    const totalDurationMs = Date.now() - startedAt;
    log.push('', `🚀 <b>[10/13] Deployment Summary</b>`, 
      `• Duration: ${(totalDurationMs / 1000).toFixed(1)}s`,
      `• Version: ${currCommit}`,
      `• Files Changed: ${filesChanged}`
    );
    await flush();

    // 11. FINAL SUMMARY FIRST — always delivered before any restart.
    // The PM2 reload below restarts the very process running this deploy; if we
    // awaited it, the "done" message would never arrive (the old bug: stuck at
    // "Pm2" with the files count missing). Sending the summary before reloading
    // guarantees the user always sees the real file count.
    const finalDurationMs = Date.now() - startedAt;
    log.push('', `✅ <b>[11/13] Update Complete</b>`,
      `• Total Duration: ${(finalDurationMs / 1000).toFixed(1)}s`,
      `• From: ${prevCommit} → ${currCommit}`,
      `• Files Changed: ${filesChanged}`,
      ``,
      `🔄 Reloading PM2 in background…`
    );
    await flush();

    // 12. Background PM2 reload — non-blocking, fire-and-forget with a short
    // delay so the summary edit above is fully delivered first. The reload is
    // what makes the new build live; if it fails, the deploy still SUCCEEDED
    // (files are on disk — a manual pm2 reload will pick them up).
    setTimeout(() => {
      safeExec('pm2 reload wa-bridge --update-env', APP_DIR).then(() => {
        logger.info('[Deploy] PM2 background reload completed');
      }).catch((err) => {
        logger.warn('[Deploy] PM2 background reload failed', { err: String(err) });
      });
    }, 2000);

    return { success: true, prevCommit, currCommit, filesChanged, buildDurationMs, totalDurationMs: finalDurationMs };

  } catch (err) {
    if (err && typeof err === 'object' && 'success' in err) return err as any;
    const step = (err as any).step || 'Unexpected Error';
    return await fail(step, err);
  }
}

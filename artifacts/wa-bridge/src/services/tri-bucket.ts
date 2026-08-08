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
// Per-user stop signal for the inner validateAllLinks loop
const stopSignals = new Set<string>();
// Abort any in-flight sessionless HTTP request when Stop is pressed.
const httpAbortControllers = new Map<string, AbortController>();

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

  let consecutiveRateErrors = 0;
  const startedAt = Date.now();
  let currentSocket = socket;
  let currentSessionId = sessionId;
  let sessionIndex = 1;

  // Clear any stale stop signal from a previous run
  stopSignals.delete(telegramId);

  for (let i = 0; i < main.length; i++) {
    // Respect stop signal — break immediately
    if (stopSignals.has(telegramId)) {
      result.remaining = main.length - i;
      break;
    }

    const entry = main[i]!;

    // Circuit breaker check
    if (await isCircuitOpen(telegramId, currentSessionId, 'validator')) {
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
        // Flush immediately to disk so join manager can use it right away
        moveToActiveBucket(telegramId, [{
          ...entry,
          jid: vr.jid,
          title: vr.title,
          memberCount: vr.memberCount,
          validatedAt: Date.now(),
          status: 'active',
        }]);
        result.activated++;
        consecutiveRateErrors = 0;
        await recordSuccess(telegramId, currentSessionId, 'validator');
      } else if (vr.transient) {
        result.errors++;
        logger.warn(`[Validator] Transient failure preserved in Main: ${entry.link} — ${vr.reason}`);
      } else {
        // Flush dead immediately too
        moveToDeadBucket(telegramId, [{
          ...entry,
          deadReason: vr.reason,
          validatedAt: Date.now(),
          status: 'dead',
        }]);
        result.killed++;
      }

      await jitter(800, 2000);
    } catch (err) {
      const msg = String(err);
      if (/rate|429|spam|flood|restrict|too.many/iu.test(msg)) {
        consecutiveRateErrors++;
        result.retries++;
        const tripped = await recordFailure(telegramId, currentSessionId, 'validator');

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

  // No final flush needed — every link is written to disk immediately
  result.remaining = loadBucket(telegramId, 'main').filter((e) => e.status === 'unvalidated').length;

  return result;
}

// ── Auto-Filter Engine ────────────────────────────────────

export function isAutoFilterRunning(telegramId: string): boolean {
  return autoFilterRunning.has(telegramId);
}

export function stopAutoFilter(telegramId: string): void {
  stopSignals.add(telegramId);   // signal inner loop to break immediately
  httpAbortControllers.get(telegramId)?.abort();
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
  stopSignals.delete(telegramId); // clear any stale stop signal

  try {
    while (autoFilterRunning.has(telegramId) && !stopSignals.has(telegramId)) {
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
    stopSignals.delete(telegramId);
  }
}

// ── Export ────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
    const CSS = [
      ':root{--bg:#050a0e;--surface:#0a1520;--surface2:#0d1e2e;--border:#0f3a5a;--accent:#00ffe7;--accent2:#00b4ff;--red:#ff2d55;--green:#00ff9d;--yellow:#ffe600;--text:#c8e6f5;--muted:#4a7a9b;--font:\'Courier New\',monospace}',
      '*{box-sizing:border-box;margin:0;padding:0}',
      'body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;overflow-x:hidden}',
      'body::before{content:\'\';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,255,231,.015) 2px,rgba(0,255,231,.015) 4px);pointer-events:none;z-index:9999}',
      '.header{padding:32px 24px 20px;border-bottom:1px solid var(--border);position:relative;overflow:hidden}',
      '.header::after{content:\'\';position:absolute;bottom:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--accent),transparent)}',
      '.logo{font-size:11px;color:var(--muted);letter-spacing:4px;text-transform:uppercase;margin-bottom:8px}',
      '.title{font-size:28px;font-weight:700;color:var(--accent);text-shadow:0 0 20px rgba(0,255,231,.4);letter-spacing:2px}',
      '.subtitle{font-size:12px;color:var(--muted);margin-top:6px;letter-spacing:1px}',
      '.stats{display:flex;gap:24px;padding:16px 24px;border-bottom:1px solid var(--border);flex-wrap:wrap}',
      '.stat{display:flex;flex-direction:column;gap:2px}',
      '.stat-label{font-size:10px;color:var(--muted);letter-spacing:2px;text-transform:uppercase}',
      '.stat-value{font-size:20px;font-weight:700;color:var(--accent);text-shadow:0 0 10px rgba(0,255,231,.3)}',
      '.toolbar{padding:14px 24px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:center;flex-wrap:wrap}',
      '.search{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--font);font-size:13px;padding:8px 14px;border-radius:4px;outline:none;width:320px;transition:border .2s}',
      '.search:focus{border-color:var(--accent);box-shadow:0 0 8px rgba(0,255,231,.2)}',
      '.search::placeholder{color:var(--muted)}',
      '.count-badge{font-size:11px;color:var(--muted);letter-spacing:1px;margin-left:auto}',
      '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;padding:20px 24px}',
      '.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;display:flex;overflow:hidden;transition:border-color .2s,box-shadow .2s;position:relative}',
      '.card:hover{border-color:var(--accent2);box-shadow:0 0 16px rgba(0,180,255,.15)}',
      '.card::before{content:attr(data-index);position:absolute;top:6px;right:8px;font-size:9px;color:var(--border);letter-spacing:1px}',
      '.thumb{width:72px;min-width:72px;background:var(--surface2);display:flex;align-items:center;justify-content:center;overflow:hidden;border-right:1px solid var(--border)}',
      '.thumb img{width:72px;height:72px;object-fit:cover;display:block}',
      '.no-thumb{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:2px}',
      '.card-body{padding:10px 12px;flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}',
      '.card-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.index{font-size:10px;color:var(--muted);letter-spacing:1px}',
      '.badge{font-size:10px;background:rgba(0,180,255,.1);border:1px solid rgba(0,180,255,.3);color:var(--accent2);padding:1px 6px;border-radius:3px;letter-spacing:.5px}',
      '.status-badge{font-size:9px;padding:2px 6px;border-radius:3px;letter-spacing:1px;font-weight:700}',
      '.status-active{background:rgba(0,255,157,.1);border:1px solid rgba(0,255,157,.3);color:var(--green)}',
      '.status-dead{background:rgba(255,45,85,.1);border:1px solid rgba(255,45,85,.3);color:var(--red)}',
      '.status-pending{background:rgba(255,230,0,.1);border:1px solid rgba(255,230,0,.3);color:var(--yellow)}',
      '.group-title{font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.link{font-size:11px;color:var(--accent2);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;transition:color .2s}',
      '.link:hover{color:var(--accent);text-decoration:underline}',
      '.jid{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.footer{padding:20px 24px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);letter-spacing:1px;text-align:center}',
      '.card.hidden{display:none}',
      '::-webkit-scrollbar{width:6px;height:6px}',
      '::-webkit-scrollbar-track{background:var(--bg)}',
      '::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}',
      '::-webkit-scrollbar-thumb:hover{background:var(--accent2)}',
    ].join('\n');

    const tsExport = new Date().toLocaleString('en-US', { hour12: false });
    const activeCount = entries.filter((e) => e.status === 'active').length;
    const deadCount = entries.filter((e) => e.status === 'dead').length;
    const pendingCount = entries.filter((e) => e.status === 'unvalidated').length;

    const cardRows = entries.map((e, i) => {
      const thumb = e.thumbnailUrl
        ? `<div class="thumb"><img src="${e.thumbnailUrl}" alt="" loading="lazy" onerror="this.parentElement.style.display=\'none\'"/></div>`
        : '<div class="thumb no-thumb"><span>WA</span></div>';
      const titleHtml = e.title ? `<div class="group-title">${escHtml(e.title)}</div>` : '';
      const membersHtml = e.memberCount ? `<span class="badge">${e.memberCount} members</span>` : '';
      const jidHtml = e.jid ? `<div class="jid">${escHtml(e.jid)}</div>` : '';
      const statusClass = e.status === 'active' ? 'status-active' : e.status === 'dead' ? 'status-dead' : 'status-pending';
      return [
        `<div class="card" data-index="${i + 1}">`,
        thumb,
        `<div class="card-body">`,
        `<div class="card-top">`,
        `<span class="index">#${String(i + 1).padStart(3, '0')}</span>`,
        `<span class="status-badge ${statusClass}">${e.status.toUpperCase()}</span>`,
        membersHtml,
        `</div>`,
        titleHtml,
        `<a class="link" href="${e.link}" target="_blank" rel="noopener">${escHtml(e.link)}</a>`,
        jidHtml,
        `</div></div>`,
      ].join('');
    }).join('\n');

    const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8"/>\n'
      + '<meta name="viewport" content="width=device-width,initial-scale=1"/>\n'
      + `<title>OMEGA // ${bucket.toUpperCase()} BUCKET</title>\n`
      + `<style>\n${CSS}\n</style>\n`
      + '</head>\n<body>\n'
      + '<div class="header">'
      + '<div class="logo">OMEGA SYSTEM // EXPORT MODULE</div>'
      + `<div class="title">&#9632; ${bucket.toUpperCase()} BUCKET</div>`
      + `<div class="subtitle">GENERATED ${tsExport} &nbsp;|&nbsp; ${entries.length} RECORDS</div>`
      + '</div>\n'
      + '<div class="stats">'
      + `<div class="stat"><span class="stat-label">Total</span><span class="stat-value">${entries.length}</span></div>`
      + `<div class="stat"><span class="stat-label">Active</span><span class="stat-value" style="color:var(--green)">${activeCount}</span></div>`
      + `<div class="stat"><span class="stat-label">Dead</span><span class="stat-value" style="color:var(--red)">${deadCount}</span></div>`
      + `<div class="stat"><span class="stat-label">Pending</span><span class="stat-value" style="color:var(--yellow)">${pendingCount}</span></div>`
      + '</div>\n'
      + '<div class="toolbar">'
      + '<input class="search" id="search" type="text" placeholder="&#9655; SEARCH GROUPS..." autocomplete="off"/>'
      + `<span class="count-badge" id="count">${entries.length} / ${entries.length}</span>`
      + '</div>\n'
      + `<div class="grid" id="grid">\n${cardRows}\n</div>\n`
      + `<div class="footer">OMEGA WA-BRIDGE &nbsp;&#9632;&nbsp; ${new Date().getFullYear()} &nbsp;&#9632;&nbsp; ${entries.length} LINKS EXPORTED</div>\n`
      + '<script>\n'
      + '(function(){'
      + 'var s=document.getElementById("search");'
      + 'var cards=document.querySelectorAll(".card");'
      + 'var cnt=document.getElementById("count");'
      + 's.addEventListener("input",function(){'
      + 'var q=s.value.toLowerCase();var v=0;'
      + 'cards.forEach(function(c){var m=c.textContent.toLowerCase().indexOf(q)!==-1;c.classList.toggle("hidden",!m);if(m)v++;});'
      + 'cnt.textContent=v+" / "+cards.length;});'
      + '})()'
      + '\n</script>\n'
      + '</body>\n</html>';

    fs.writeFileSync(filepath, html);
  }

  return filepath;
}

// ── Sessionless HTTP Validator ──────────────────────────────

/**
 * Validate a WhatsApp group link without a WhatsApp session.
 * Uses HTTP HEAD/GET to check if the invite page returns a valid group.
 * No socket needed — works purely via HTTP.
 */
export async function validateLinkHttp(link: string, signal?: AbortSignal): Promise<ValidationResult> {
  const code = extractInviteCode(link);
  if (!code) return { link, isValid: false, reason: 'Invalid link format' };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let html = '';
    let status = 0;
    try {
      const res = await fetch(`https://chat.whatsapp.com/${code}`, {
        signal: signal ?? controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });
      status = res.status;
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }

    // Hard dead signals
    if (status === 404 || status === 410) {
      return { link, isValid: false, reason: `HTTP ${status}` };
    }

    const dead =
      html.includes('This invite link is invalid') ||
      html.includes('This link is no longer valid') ||
      html.includes('Invalid Link') ||
      html.includes('link has expired') ||
      html.includes('revoked');

    if (dead) return { link, isValid: false, reason: 'Link revoked or expired' };

    // Must have BOTH og:title AND a group name signal to be considered active
    const hasOgTitle = html.includes('<meta property="og:title"');
    const hasGroupSignal =
      html.includes('"groupName"') ||
      html.includes('"groupInvite"') ||
      html.includes('wa-group') ||
      (hasOgTitle && html.includes('og:description') && html.includes('member'));

    if (!hasGroupSignal) {
      // Ambiguous — could be JS-rendered or rate limited, treat as transient
      return { link, isValid: false, reason: 'Could not confirm group', transient: true };
    }

    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    const title = titleMatch?.[1];
    const memberMatch = descMatch?.[1]?.match(/(\d+)\s+member/);

    return {
      link,
      isValid: true,
      title: title ?? undefined,
      memberCount: memberMatch ? parseInt(memberMatch[1]!, 10) : undefined,
    };
  } catch (err) {
    const msg = String(err);
    if (msg.includes('abort') || msg.includes('timeout')) {
      return { link, isValid: false, reason: 'Request timed out', transient: true };
    }
    return { link, isValid: false, reason: msg, transient: true };
  }
}

/**
 * Batch HTTP validate links from main bucket — no session needed.
 */
export async function validateLinksHttp(
  telegramId: string,
  onProgress?: (msg: string) => Promise<void>
): Promise<{ activated: number; killed: number; errors: number }> {
  const main = loadBucket(telegramId, 'main').filter(e => e.status === 'unvalidated');
  const result = { activated: 0, killed: 0, errors: 0 };
  const startedAt = Date.now();
  const abortController = new AbortController();
  httpAbortControllers.set(telegramId, abortController);

  stopSignals.delete(telegramId);
  autoFilterRunning.add(telegramId);

  try {
    for (let i = 0; i < main.length; i++) {
      if (stopSignals.has(telegramId)) {
        abortController.abort();
        break;
      }

      const entry = main[i]!;
      const vr = await validateLinkHttp(entry.link, abortController.signal);

      // Persist each terminal result immediately. The live Hub can therefore
      // expose a link as soon as its request completes, without waiting for a
      // large batch flush.
      if (vr.isValid) {
        moveToActiveBucket(telegramId, [{
          ...entry,
          title: vr.title,
          memberCount: vr.memberCount,
          validatedAt: Date.now(),
          status: 'active',
        }]);
        result.activated++;
      } else if (!vr.transient) {
        moveToDeadBucket(telegramId, [{
          ...entry,
          deadReason: vr.reason,
          validatedAt: Date.now(),
          status: 'dead',
        }]);
        result.killed++;
      } else {
        // Transient failures stay in Main for a later safe retry.
        result.errors++;
      }

      const elapsedMinutes = Math.max((Date.now() - startedAt) / 60000, 0.01);
      await onProgress?.(
        [
          `<blockquote><b>◈ OMEGA HTTP VALIDATOR</b>`,
          ``,
          `Checked    ${i + 1}/${main.length}`,
          `Active     ${result.activated}`,
          `Dead       ${result.killed}`,
          `Errors     ${result.errors}`,
          ``,
          `Status     ● RUNNING`,
          `Current    ${entry.link.slice(-35)}`,
          `Speed      ${((i + 1) / elapsedMinutes).toFixed(1)} links/min`,
          `</blockquote>`,
        ].join('\n')
      );

      // Keep the upstream request rate conservative while making the bucket
      // state immediately available after each completed result.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 400 + Math.random() * 300);
        abortController.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  } finally {
    abortController.abort();
    httpAbortControllers.delete(telegramId);
    autoFilterRunning.delete(telegramId);
    stopSignals.delete(telegramId);
  }

  return result;
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

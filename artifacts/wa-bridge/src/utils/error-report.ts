// ============================================================
// WA-Bridge — Error Report Engine
//
// One universal internal error report used by every command catch
// block. Renders in the session's selected response mode:
//
//   TXT   — the canonical OMEGA error report card
//   TABLE — the same data as the native Baileys table
//           (GenATableUXPrimitive via richResponseMessage)
//
// ── TXT example ─────────────────────────────────────────────
//   【 ❌ ERROR REPORT 】
//   Version : 6.1.1
//   Command : cs
//   Message : .cs
//   Error   : fetch failed
//   Chat    : 120363xxxx@g.us
//   Platform: VPS
//   ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ———
// ============================================================

export interface ErrorReportData {
  /** Bot/engine version. */
  version: string;
  /** Command name that failed (no prefix). */
  command: string;
  /** The raw triggering message (message text or command line). */
  message: string;
  /** The error message. */
  error: string;
  /** Chat JID (group or DM). */
  chat: string;
  /** Platform the bot runs on (VPS, Docker, Replit…). */
  platform: string;
  /** Optional extra rows (e.g. Session ID). */
  extra?: [string, string][];
}

const BRAND = '𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭';

/** Sanitise error text: collapse newlines and strip ANSI codes. */
function clean(s: string): string {
  return String(s ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Current platform label. */
export function platformLabel(): string {
  const env = process.env.PLATFORM ?? process.env.OMEGA_PLATFORM;
  return env && env.trim() ? env.trim() : 'VPS';
}

/** Stable bot version read once at startup (env override → package version → 6.1.1). */
export const BOT_VERSION: string = (() => {
  if (process.env.OMEGA_VERSION && process.env.OMEGA_VERSION.trim()) {
    return process.env.OMEGA_VERSION.trim();
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version?: string };
    if (pkg?.version) return pkg.version;
  } catch {
    /* non-critical */
  }
  return '6.1.1';
})();

/** Render an error report as TXT (canonical OMEGA card). */
export function errorReportText(data: ErrorReportData): string {
  const rows: [string, string][] = [
    ['Version', clean(data.version || BOT_VERSION)],
    ['Command', clean(data.command) || '—'],
    ['Message', clean(data.message).slice(0, 80) || '—'],
    ['Error', clean(data.error).slice(0, 120) || 'Unknown'],
    ['Chat', clean(data.chat) || '—'],
    ['Platform', clean(data.platform || platformLabel())],
    ...(data.extra ?? []),
  ];
  const body = rows
    .map(([k, v]) => `  ${k.padEnd(8)}: ${v}`)
    .join('\n');
  return [
    '【 ❌ ERROR REPORT 】',
    body,
    `——— ${BRAND} ———`,
  ].join('\n');
}

/** Render an error report as a native-table-friendly structure. */
export function errorReportTable(data: ErrorReportData): {
  title: string;
  rows: (string | number)[][];
} {
  const rows: (string | number)[][] = [
    ['Field', 'Value'],
    ['Version', clean(data.version || BOT_VERSION)],
    ['Command', clean(data.command) || '—'],
    ['Message', clean(data.message).slice(0, 80) || '—'],
    ['Error', clean(data.error).slice(0, 120) || 'Unknown'],
    ['Chat', clean(data.chat) || '—'],
    ['Platform', clean(data.platform || platformLabel())],
    ...(data.extra ?? []).map(([k, v]) => [k, clean(v)] as [string, string]),
  ];
  return { title: '❌ ERROR REPORT', rows };
}

// ============================================================
// WA-Bridge — Telegram HTML & MarkdownV2 Formatters
// Telegram Bot API 9.0+: HTML parse mode preferred
// ============================================================

import type { JobResult } from '../types/index.js';
import { humanDuration } from './delay.js';

// ── HTML Helpers ──────────────────────────────────────────

export const H = {
  bold: (s: string) => `<b>${s}</b>`,
  italic: (s: string) => `<i>${s}</i>`,
  code: (s: string) => `<code>${s}</code>`,
  pre: (s: string, lang = '') => `<pre${lang ? ` language="${lang}"` : ''}>${escape(s)}</pre>`,
  link: (text: string, url: string) => `<a href="${url}">${text}</a>`,
  spoiler: (s: string) => `<tg-spoiler>${s}</tg-spoiler>`,
  blockquote: (s: string, expandable = false) =>
    expandable ? `<blockquote expandable>${s}</blockquote>` : `<blockquote>${s}</blockquote>`,
  emoji: (id: string) => `<tg-emoji emoji-id="${id}">👾</tg-emoji>`,
  u: (s: string) => `<u>${s}</u>`,
  s: (s: string) => `<s>${s}</s>`,
};

/** Escape HTML special characters */
export function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Page/Section Helpers ──────────────────────────────────

export function header(title: string, emoji = '🤖'): string {
  return `${emoji} ${H.bold(title)}\n${H.code('─'.repeat(30))}`;
}

export function kv(label: string, value: string, pad = 12): string {
  return `${H.bold(label.padEnd(pad))} ${value}`;
}

/** Rich expandable blockquote for logs/errors */
export function errorBlock(error: string, context?: string): string {
  const body = context ? `${context}\n\n${error}` : error;
  return H.blockquote(H.pre(body, 'log'), true);
}

// ── Session Card ──────────────────────────────────────────

export function sessionCard(opts: {
  sessionId: string;
  phone: string;
  status: string;
  paired: boolean;
  groups?: number;
  frozen?: boolean;
}): string {
  const statusEmoji = {
    open: '🟢',
    connecting: '🟡',
    frozen: '🔵',
    error: '🔴',
    banned: '💀',
    closed: '⚫',
  }[opts.status] ?? '⚪';

  const lines = [
    header(`Session: ${opts.sessionId}`, statusEmoji),
    '',
    kv('Phone:', opts.phone),
    kv('Status:', `${statusEmoji} ${opts.status.toUpperCase()}`),
    kv('Paired:', opts.paired ? '✅ Yes' : '❌ No'),
  ];

  if (opts.groups !== undefined) lines.push(kv('Groups:', String(opts.groups)));
  if (opts.frozen) lines.push('', H.blockquote(`🔵 Session traffic is ${H.bold('FROZEN')}`));

  return lines.join('\n');
}

// ── Job Result Card ───────────────────────────────────────

export function jobResultCard(op: string, result: JobResult): string {
  const lines = [
    header(`${op.toUpperCase()} Complete`, '📊'),
    '',
    kv('✅ Success:', String(result.success)),
    kv('❌ Failed:', String(result.failed)),
    kv('⏭ Skipped:', String(result.skipped)),
    kv('🚦 Rate-Ltd:', String(result.rateLimited)),
    kv('⏱ Duration:', humanDuration(result.duration)),
  ];

  if (result.details.length > 0) {
    lines.push('');
    lines.push(
      H.blockquote(
        H.bold('Details') + '\n' +
        H.pre(result.details.slice(0, 20).join('\n'), 'log'),
        true
      )
    );
  }

  return lines.join('\n');
}

// ── Bucket Status Card ────────────────────────────────────

export function bucketCard(opts: {
  main: number;
  active: number;
  dead: number;
  filterActive: boolean;
}): string {
  return [
    header('Link Bucket Status', '🗂'),
    '',
    kv('📥 Main:', String(opts.main)),
    kv('✅ Active:', String(opts.active)),
    kv('💀 Dead:', String(opts.dead)),
    '',
    kv('Auto-Filter:', opts.filterActive ? '🟢 Running' : '🔴 Stopped'),
  ].join('\n');
}

// ── Pairing Card ─────────────────────────────────────────

export function pairingCodeCard(phone: string, code: string): string {
  return [
    header('WhatsApp Pairing Code', '🔗'),
    '',
    kv('Phone:', phone),
    '',
    H.bold('Your pairing code:'),
    H.code(code),
    '',
    H.blockquote(
      `Open WhatsApp → Linked Devices → Link a Device → Enter Code`
    ),
    '',
    H.italic('⚠️ Code expires in 60 seconds. Request a new one if needed.'),
  ].join('\n');
}

export function mainMenu(telegramId: string, isOwner: boolean): string {
  const lines = [
    header('WA-Bridge Control Center', '🤖'),
    '',
    H.blockquote(
      `Welcome back! Manage your WhatsApp sessions,\nlink buckets, and mass outreach from here.`
    ),
    '',
    H.bold('Quick Actions:'),
    `  /sessions — Manage WhatsApp sessions`,
    `  /bucket   — Link validator hub`,
    `  /help     — Full command reference`,
  ];

  if (isOwner) {
    lines.push('');
    lines.push(H.bold('Admin:'));
    lines.push(`  /admin    — Platform governance`);
  }

  return lines.join('\n');
}

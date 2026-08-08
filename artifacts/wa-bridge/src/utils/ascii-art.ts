// ============================================================
// WA-Bridge — Native WhatsApp Message Styling
// WhatsApp supports *bold*, _italic_, ~strikethrough~, ```code```
// Compact PAPPY • OMEGA design language.
// ============================================================

import { pappyBox } from './pappy-engine.js';
import { error as compactError, info as compactInfo, mini, success as compactSuccess, warning as compactWarning, config as compactConfig } from '../services/ResponseEngine.js';

export interface AsciiBoxOptions {
  title: string;
  rows: [string, string][];
  footer?: string;
  emoji?: string;
  moduleIdentity?: string;
}

export const bold = (value: string): string => `*${value}*`;
export const italic = (value: string): string => `_${value}_`;
export const mono = (value: string): string => `\`\`\`${value}\`\`\``;
export const strike = (value: string): string => `~${value}~`;
export const quote = (value: string): string => value.split('\n').map((line) => `> ${line}`).join('\n');

/** Compact, native WhatsApp card. */
export function asciiBox(opts: AsciiBoxOptions): string {
  const emoji = opts.emoji ?? '';
  const detail = opts.footer;
  if (emoji.startsWith('✅')) return compactSuccess(opts.title, detail, opts.rows);
  if (emoji.startsWith('❌')) return compactError(opts.title, detail, opts.rows);
  if (emoji.startsWith('⚠️')) return compactWarning(opts.title, detail, opts.rows);
  if (emoji.startsWith('ℹ️')) return compactInfo(opts.title, detail, opts.rows);
  if (emoji.startsWith('⚙️')) return compactConfig(opts.title, opts.rows, detail);
  return [mini(opts.title, detail, emoji || '◈'), ...opts.rows.map(([label, value]) => `└ ${label}: ${value}`)].filter(Boolean).join('\\n');
}

/** Lightweight spacing divider */
export const divider = (): string => '';

export function successCard(title: string, message: string, rows: [string, string][] = [], module?: string): string {
  return asciiBox({ title, emoji: '✅', rows, footer: message, moduleIdentity: module });
}

export function warningCard(title: string, message: string, rows: [string, string][] = [], module?: string): string {
  return asciiBox({ title, emoji: '⚠️', rows, footer: message, moduleIdentity: module });
}

export function errorCard(title: string, message: string, details?: string, module?: string): string {
  return [asciiBox({ title, emoji: '❌', rows: [], footer: message, moduleIdentity: module }), details ? `\n${mono(details.slice(0, 200))}` : '']
    .filter(Boolean)
    .join('\n');
}

// ── Premium Cards ─────────────────────────────────────────

/** Rich ping card with latency and session status */
export function pingCard(opts: { 
  latency: number; 
  sessionId: string; 
  status: string;
  runtime?: string;
  ram?: string;
  platform?: string;
  version?: string;
}): string {
  const statusEmoji = opts.status === 'FROZEN' ? '❄️' : opts.status === 'MEASURING' ? '🔄' : '🟢';
  const rows: [string, string][] = [
    ['Latency', opts.status === 'MEASURING' ? '…' : `${opts.latency}ms`],
    ['Session', opts.sessionId],
  ];

  if (opts.runtime) rows.push(['Runtime', opts.runtime]);
  if (opts.ram) rows.push(['RAM', opts.ram]);
  if (opts.platform) rows.push(['Platform', opts.platform]);
  if (opts.version) rows.push(['Version', opts.version]);
  
  rows.push(['Status', `${statusEmoji} ${opts.status}`]);

  return asciiBox({
    title: 'PONG',
    emoji: '🏓',
    moduleIdentity: 'CORE STATUS',
    rows,
  });
}

/** Rich session info card */
export function infoCard(opts: {
  sessionId: string;
  status: string;
  groups: number;
  prefix: string;
  nullMode: boolean;
  spamLoop: boolean;
  sudoCount: number;
}): string {
  const statusEmoji = opts.status === 'FROZEN' ? '❄️' : opts.status === 'ONLINE' ? '🟢' : '🔴';
  return asciiBox({
    title: 'SESSION STATUS',
    emoji: '📱',
    moduleIdentity: 'STATUS ENGINE',
    rows: [
      ['Status', `${statusEmoji} ${opts.status}`],
      ['Session', opts.sessionId],
      ['Groups', String(opts.groups)],
      ['Prefix', opts.prefix],
      ['Null Mode', opts.nullMode ? '◉ ON' : '◎ OFF'],
      ['Spam Loop', opts.spamLoop ? '🔄 RUNNING' : '◎ OFF'],
      ['Sudo Users', String(opts.sudoCount)],
    ],
    footer: 'OMEGA SYSTEM · ALL ENGINES READY',
  });
}

/** Sudo registry list card */
export function sudoListCard(numbers: string[]): string {
  if (numbers.length === 0) {
    return asciiBox({
      title: 'SUDO REGISTRY',
      emoji: '🔐',
      moduleIdentity: 'VALIDATOR',
      rows: [['Authorized', '0']],
      footer: 'No sudo operators configured.',
    });
  }
  const roster = numbers.map((n, i) => `${i + 1}. +${n}`).join('\n');
  return [
    asciiBox({
      title: 'SUDO REGISTRY',
      emoji: '🔐',
      moduleIdentity: 'VALIDATOR',
      rows: [['Authorized', String(numbers.length)]],
    }),
    `\n${quote(roster)}`,
  ].join('\n');
}

/** Groups list card */
export function groupsCard(groups: { name: string; count: number }[]): string {
  if (groups.length === 0) {
    return asciiBox({
      title: 'JOINED GROUPS',
      emoji: '📋',
      moduleIdentity: 'GROUP MANAGER',
      rows: [['Total', '0']],
      footer: 'No groups joined.',
    });
  }
  const visible = groups.slice(0, 25);
  const list = visible.map((g, i) => `${i + 1}. ${g.name} [${g.count}]`).join('\n');
  const overflow = groups.length > 25 ? `\n+${groups.length - 25} more` : '';
  return [
    asciiBox({
      title: 'JOINED GROUPS',
      emoji: '📋',
      moduleIdentity: 'GROUP MANAGER',
      rows: [['Total', String(groups.length)]],
    }),
    `\n${quote(list + overflow)}`,
  ].join('\n');
}

export function resultBox(opts: {
  op: string;
  success: number;
  failed: number;
  skipped: number;
  rateLimited: number;
  duration: string;
}): string {
  return asciiBox({
    title: `${opts.op.toUpperCase()} COMPLETE`,
    emoji: '📊',
    moduleIdentity: 'TASK ENGINE',
    rows: [
      ['Success', String(opts.success)],
      ['Failed', String(opts.failed)],
      ['Skipped', String(opts.skipped)],
      ['Rate limited', String(opts.rateLimited)],
      ['Duration', opts.duration],
    ],
    footer: 'Operation finished.',
  });
}

export function sessionBox(opts: {
  sessionId: string;
  phone: string;
  status: string;
  groups: number;
  connectedSessions?: number;
  device?: string;
  node?: string;
  workspace?: string;
  runtime?: string;
  memory?: string;
  version?: string;
  lastReconnect?: string;
}): string {
  const rows: [string, string][] = [
    ['ID', opts.sessionId],
    ['Owner', opts.phone],
    ['Status', opts.status.toUpperCase()],
    ['Groups', String(opts.groups)],
  ];

  if (opts.connectedSessions !== undefined) rows.push(['Sessions', String(opts.connectedSessions)]);
  if (opts.device) rows.push(['Device', opts.device]);
  if (opts.node) rows.push(['Node', opts.node]);
  if (opts.workspace) rows.push(['Workspace', opts.workspace]);
  if (opts.runtime) rows.push(['Runtime', opts.runtime]);
  if (opts.memory) rows.push(['Memory', opts.memory]);
  if (opts.version) rows.push(['Version', opts.version]);
  if (opts.lastReconnect) rows.push(['Last Reconnect', opts.lastReconnect]);

  return asciiBox({
    title: 'SESSION INTERFACE',
    emoji: '🖥️',
    moduleIdentity: 'SESSION MANAGER',
    rows,
  });
}

export function connectedCard(opts: { name: string; phone: string; sessionId: string; method: string }): string {
  return asciiBox({
    title: 'SESSION ONLINE',
    emoji: '●',
    moduleIdentity: 'CORE STATUS',
    rows: [
      ['Name', opts.name],
      ['Number', `+${opts.phone}`],
      ['Method', opts.method],
      ['Status', 'CONNECTED ✔'],
    ],
    footer: 'BOT ACTIVE — AWAITING COMMANDS',
  });
}

// ── Premium Tips (rotating) ──────────────────────────────

const PREMIUM_TIPS: string[] = [
  '💎 Premium: Unlimited group status broadcasts.',
  '💎 Premium: Priority queue for joinall & leaveall.',
  '💎 Premium: Custom menu media (video/image).',
  '💎 Premium: Multi-session from single Telegram.',
  '💎 Premium: Real-time join-manager approvals.',
  '💎 Premium: AntiNSFW AI content detection.',
  '💎 Premium: Auto-approval with country targets.',
  '💎 Premium: Dedicated support & feature requests.',
  '💎 Premium: Custom status design themes.',
  '💎 Premium: Unlimited bucket capacity.',
];

/** Get a rotating premium tip based on day of year (deterministic) */
export function getPremiumTip(index?: number): string {
  if (index !== undefined) {
    return PREMIUM_TIPS[index % PREMIUM_TIPS.length];
  }
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return PREMIUM_TIPS[dayOfYear % PREMIUM_TIPS.length];
}

// ── COMPACT GOTHIC • OMEGA MENU ──────────────────────────
//
// Registry-driven: the command list is built from MENU_CATALOG by
// services/help.ts, so the menu can never drift from the codebase.
// One command per line (command + one-line purpose), compact separators,
// no giant ASCII boxes, WhatsApp-mobile-width friendly (~35 chars/line).

export function whatsappMenu(
  title: string,
  sections: { heading: string; items: { cmd: string; desc: string }[] }[],
  prefix = '.'
): string {
  const lines: string[] = [];

  // Gothic header (compact, single line)
  const safePrefix = prefix && prefix.trim() ? prefix.trim() : '(none)';
  lines.push(`⚜ ${title} ⚜`);
  lines.push(`▸ prefix: ${safePrefix} ▸ status: ONLINE`);
  lines.push('');

  for (const section of sections) {
    const heading = section.heading.trim();
    lines.push(`─── ${heading} ───`);

    for (const item of section.items) {
      // One line per command: `.cmd — purpose`, truncated to WhatsApp width.
      const cmd = item.cmd.trim();
      const maxDesc = Math.max(12, 33 - cmd.length);
      const desc =
        item.desc.length > maxDesc
          ? `${item.desc.slice(0, maxDesc - 1)}…`
          : item.desc;
      lines.push(`▸ ${cmd} — ${desc}`);
    }
    lines.push('');
  }

  lines.push(`╰─ ${getPremiumTip()}`);
  return lines.join('\n');
}

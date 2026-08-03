// ============================================================
// WA-Bridge — Native WhatsApp Message Styling
// WhatsApp supports *bold*, _italic_, ~strikethrough~, ```code```
// ============================================================

import { pappyBox } from './pappy-engine.js';

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

/** Compact, native WhatsApp card. Kept under the legacy name for API compatibility. */
export function asciiBox(opts: AsciiBoxOptions): string {
  return pappyBox({
    title: opts.title,
    rows: opts.rows,
    footer: opts.footer,
    emoji: opts.emoji,
    moduleIdentity: opts.moduleIdentity,
  });
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
export function pingCard(opts: { latency: number; sessionId: string; status: string }): string {
  const statusEmoji = opts.status === 'FROZEN' ? '❄️' : opts.status === 'MEASURING' ? '🔄' : '🟢';
  return asciiBox({
    title: 'PONG',
    emoji: '🏓',
    moduleIdentity: 'CORE STATUS',
    rows: [
      ['Latency', opts.status === 'MEASURING' ? '…' : `${opts.latency}ms`],
      ['Session', opts.sessionId],
      ['Status', `${statusEmoji} ${opts.status}`],
    ],
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
}): string {
  return asciiBox({
    title: 'SESSION INFO',
    emoji: '📱',
    moduleIdentity: 'SESSION MANAGER',
    rows: [
      ['ID', opts.sessionId],
      ['Owner', opts.phone],
      ['Status', opts.status.toUpperCase()],
      ['Groups', String(opts.groups)],
    ],
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
  '💎 Premium unlock: Unlimited group status broadcasts with zero rate limits.',
  '💎 Premium unlock: Priority queue for joinall & leaveall operations.',
  '💎 Premium unlock: Custom menu media (video/image) for branded menus.',
  '💎 Premium unlock: Multi-session management from a single Telegram.',
  '💎 Premium unlock: Real-time join-manager with country-based approvals.',
  '💎 Premium unlock: AntiNSFW AI-powered content detection engine.',
  '💎 Premium unlock: Auto-approval pipeline with scheduled country targets.',
  '💎 Premium unlock: Dedicated support channel & feature requests.',
  '💎 Premium unlock: Custom status design themes beyond the free set.',
  '💎 Premium unlock: Unlimited bucket capacity for group links.',
];

/** Get a rotating premium tip based on day of year (deterministic) */
export function getPremiumTip(index?: number): string {
  if (index !== undefined) {
    return PREMIUM_TIPS[index % PREMIUM_TIPS.length];
  }
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return PREMIUM_TIPS[dayOfYear % PREMIUM_TIPS.length];
}

export function whatsappMenu(
  _title: string,
  sections: { heading: string; items: { cmd: string; desc: string }[] }[]
): string {
  const cleanCommand = (cmd: string): string => cmd.trim().split(/\s+/u)[0] ?? cmd.trim();
  const safeDivider = '────────────────────';
  
  // Menu also uses the PAPPY engine for consistency
  const rows: [string, string][] = [
    ['SYSTEM', '◉ ONLINE'],
    ['SESSION', '◉ VERIFIED'],
    ['ENGINE', '◉ READY'],
  ];

  let menuBody = '';
  for (const section of sections) {
    menuBody += `\n${safeDivider}\n${bold(section.heading)}\n${safeDivider}\n`;
    for (const item of section.items) {
      menuBody += `◈ *${cleanCommand(item.cmd)}*\n  └ ${item.desc}\n`;
    }
  }

  menuBody += `\n${safeDivider}\n${bold('PREMIUM HIGHLIGHT')}\n${safeDivider}\n◉ ${getPremiumTip()}\n`;

  return asciiBox({
    title: 'OMEGA • CORE',
    emoji: '◈',
    moduleIdentity: 'CONTROL INTERFACE',
    rows,
    footer: menuBody + `\n${safeDivider}\n⟦ Awaiting Operator Command... ⟧`
  });
}

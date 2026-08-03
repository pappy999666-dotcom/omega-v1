// ============================================================
// WA-Bridge — Native WhatsApp Message Styling
// WhatsApp supports *bold*, _italic_, ~strikethrough~, ```code```
// Compact PAPPY • OMEGA design language.
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

/** Compact, native WhatsApp card. */
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

// ── COMPACT PAPPY • OMEGA MENU ───────────────────────────

const DIVIDER = '╠═════════════════════════╣';

/**
 * Compact WhatsApp menu renderer.
 * Produces the PAPPY • OMEGA design with section boxes
 * that fit within WhatsApp mobile width (~35 chars).
 */
export function whatsappMenu(
  _title: string,
  sections: { heading: string; items: { cmd: string; desc: string }[] }[]
): string {
  const cleanCommand = (cmd: string): string => cmd.trim().split(/\s+/u)[0] ?? cmd.trim();

  // Gothic Header (Compact)
  const lines: string[] = [
    '┏━━ ✠ 𝕺𝕸𝕰𝕲𝕬 • 𝕮𝕺𝕽𝕰 ✠ ━━┓',
    '┃ 𝕾𝖙𝖆𝖙𝖚𝖘: 𝕺𝖓𝖑𝖎𝖓𝖊 • 𝕻𝖗𝖊𝖋𝖎𝖝: .',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
  ];

  // Section rendering
  for (const section of sections) {
    lines.push('');
    // Heading in Gothic Unicode
    const gothicHeading = section.heading
      .replace(/MODERATION/g, '𝕸𝖔𝖉𝖊𝖗𝖆𝖙𝖎𝖔𝖓')
      .replace(/UTILITY/g, '𝖀𝖙𝖎𝖑𝖎𝖙𝖞')
      .replace(/CONFIGURATION/g, '𝕮𝖔𝖓𝖋𝖎𝖌𝖚𝖗𝖆𝖙𝖎𝖔𝖓')
      .replace(/STICKER ENGINE/g, '𝕾𝖙𝖎𝖈𝖐𝖊𝖗 𝕰𝖓𝖌𝖎𝖓𝖊')
      .replace(/ANTI SYSTEM/g, '𝕬𝖓𝖙𝖎 𝕾𝖞𝖘𝖙𝖊𝖒');
    
    lines.push(`⚔ ${gothicHeading}`);

    // Group commands by prefix similarity or just list them compactly
    const items = section.items;
    const groups: string[][] = [];
    
    // Simple grouping logic for common commands
    const processed = new Set<number>();
    for (let i = 0; i < items.length; i++) {
      if (processed.has(i)) continue;
      const cmd1 = cleanCommand(items[i]!.cmd);
      const baseCmd = cmd1.replace(/all|x$/g, '');
      const group = [cmd1];
      processed.add(i);
      
      for (let j = i + 1; j < items.length; j++) {
        if (processed.has(j)) continue;
        const otherCmd = cleanCommand(items[j]!.cmd);
        if (otherCmd.startsWith(baseCmd) || (cmd1 === '.tag' && otherCmd === '.mtag')) {
          group.push(otherCmd);
          processed.add(j);
        }
      }
      groups.push(group);
    }

    for (const group of groups) {
      lines.push(group.join(' • '));
    }
  }

  // Footer
  lines.push('');
  lines.push(`╰─ ${getPremiumTip()}`);

  return lines.join('\n');
}

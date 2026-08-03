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

  // Header
  const lines: string[] = [
    '╔══ ✠ 𝕻𝕬𝕻𝕻𝖄 • 𝕺𝕸𝕰𝕲𝕬 ✠ ══╗',
    '║',
    '║  ⛧ 𝕮𝕳𝕽𝕺𝕹𝕴𝕮𝕷𝕰 𝕺𝕱 𝕿𝕳𝕰 𝕮𝕺𝕽𝕰 ⛧',
    '║  𝕲𝖔𝖙𝖍𝖎𝖈 • 𝕮𝖞𝖇𝖊𝖗 • 𝕬𝖚𝖙𝖔',
    '║',
    DIVIDER,
    '',
    '  ⛧「 𝕮𝕺𝕽𝕰 𝕾𝕿𝕬𝕿𝕰 」⛧',
    '',
    ' ✦ Engine  ⟫  OMEGA CORE',
    ' ✦ Status  ⟫  ONLINE',
    ' ✦ Session ⟫  VERIFIED',
    ' ✦ Prefix  ⟫  .',
    ' ✦ Runtime ⟫  STABLE',
    '',
    DIVIDER,
  ];

  // Section boxes — compact layout
  for (const section of sections) {
    lines.push('');
    lines.push(`✠ ${section.heading.toUpperCase()}`);

    // Check if section has many items — use compact grid for moderation/anti
    const isCrowded = section.items.length > 4;
    const maxCmdWidth = Math.max(...section.items.map(item => cleanCommand(item.cmd).length));

    if (isCrowded) {
      // Grid layout: pair items on same line for compact display
      lines.push('╭─────────────────────╮');
      const items = section.items;
      for (let i = 0; i < items.length; i += 2) {
        const item1 = items[i]!;
        const cmd1 = cleanCommand(item1.cmd);
        const line = `│ ☩ ${bold(cmd1)}`;
        if (items[i + 1]) {
          const item2 = items[i + 1]!;
          const cmd2 = cleanCommand(item2.cmd);
          lines.push(`${line} ☩ ${bold(cmd2)} │`);
        } else {
          // Pad single item to fill line
          const padding = ' '.repeat(Math.max(0, 16 - cmd1.length));
          lines.push(`${line}${padding} │`);
        }
      }
      lines.push('╰─────────────────────╯');
    } else {
      // Standard compact box
      lines.push('╭─────────────────────╮');
      for (const item of section.items) {
        const cmd = cleanCommand(item.cmd);
        lines.push(`│ ☩ ${bold(cmd)}`);
        if (item.desc && item.desc !== '—') {
          lines.push(`│   ╰─ ${item.desc}`);
        }
      }
      lines.push('╰─────────────────────╯');
    }
  }

  // Premium tip section
  lines.push('');
  lines.push(DIVIDER);
  lines.push('');
  lines.push('  ☩ SECURITY MATRIX ☩');
  lines.push('');
  lines.push('  ▰▰▰▰▰▰▰▰▰▰');
  lines.push('  INTEGRITY : 100%');
  lines.push('');
  lines.push('  ◉ Encryption Active');
  lines.push('  ◉ Defense Online');
  lines.push('  ◉ Events Synced');
  lines.push('  ◉ AI Core Operational');
  lines.push('');
  lines.push(DIVIDER);
  lines.push('');
  lines.push('  ⚜「 AWAITING OPERATOR 」⚜');
  lines.push('   𝕰𝖝𝖊𝖈 • 𝕯𝖔𝖒 • 𝕽𝖊𝖕');
  lines.push('');
  lines.push('╚══ ✠ 𝕻𝕬𝕻𝕻𝖄 ×͜× ✠ ══════╝');

  return lines.join('\n');
}

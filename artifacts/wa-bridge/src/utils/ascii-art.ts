// ============================================================
// WA-Bridge — Native WhatsApp Message Styling
// WhatsApp supports *bold*, _italic_, ~strikethrough~, ```code```
// ============================================================

export interface AsciiBoxOptions {
  title: string;
  rows: [string, string][];
  footer?: string;
  emoji?: string;
  width?: number;
}

export const bold = (value: string): string => `*${value}*`;
export const italic = (value: string): string => `_${value}_`;
export const mono = (value: string): string => `\`\`\`${value}\`\`\``;
export const strike = (value: string): string => `~${value}~`;
export const quote = (value: string): string => value.split('\n').map((line) => `> ${line}`).join('\n');

/** Compact, native WhatsApp card. Kept under the legacy name for API compatibility. */
export function asciiBox(opts: AsciiBoxOptions): string {
  const heading = `${opts.emoji ? `${opts.emoji} ` : ''}${bold(opts.title)}`;
  const rows = opts.rows.map(([label, value]) => `${bold(`${label}:`)} ${value}`);
  return [heading, '', ...rows, opts.footer ? `\n${quote(opts.footer)}` : '']
    .filter(Boolean)
    .join('\n');
}

/** Lightweight spacing divider */
export const divider = (): string => '';

export function successCard(title: string, message: string, rows: [string, string][] = []): string {
  return asciiBox({ title, emoji: '✅', rows, footer: message });
}

export function warningCard(title: string, message: string, rows: [string, string][] = []): string {
  return asciiBox({ title, emoji: '⚠️', rows, footer: message });
}

export function errorCard(title: string, message: string, details?: string): string {
  return [asciiBox({ title, emoji: '❌', rows: [], footer: message }), details ? `\n${mono(details.slice(0, 200))}` : '']
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
      rows: [['Authorized', '0']],
      footer: 'No sudo operators configured.',
    });
  }
  const roster = numbers.map((n, i) => `${i + 1}. +${n}`).join('\n');
  return [
    asciiBox({
      title: 'SUDO REGISTRY',
      emoji: '🔐',
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
    rows: [
      ['ID', opts.sessionId],
      ['Owner', opts.phone],
      ['Status', opts.status.toUpperCase()],
      ['Groups', String(opts.groups)],
    ],
  });
}

export function connectedCard(opts: { name: string; phone: string; sessionId: string; method: string }): string {
  return [
    '```',
    '┌────────────────────────────────────────────┐',
    '│  ► PAPPY-BOT — SESSION ONLINE                  │',
    '├────────────────────────────────────────────┤',
    `│  👤 Name    : ${opts.name.slice(0, 22).padEnd(22)}  │`,
    `│  📱 Number  : +${opts.phone.slice(0, 21).padEnd(21)}  │`,
    `│  🔗 Method  : ${opts.method.slice(0, 22).padEnd(22)}  │`,
    '├────────────────────────────────────────────┤',
    '│  STATUS  : ● CONNECTED ✔                        │',
    '│  BOT     : ACTIVE — AWAITING COMMANDS           │',
    '└────────────────────────────────────────────┘',
    '```',
  ].join('\n');
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
  const lines: string[] = [
    '⟦ ◈ *OMEGA • CORE* ◈ ⟧',
    '_WA-BRIDGE / CONTROL INTERFACE_',
    '',
    'SYSTEM      ◉ ONLINE',
    'SESSION     ◉ VERIFIED',
    'ENGINE      ◉ READY',
  ];

  for (const section of sections) {
    lines.push('', safeDivider, section.heading, safeDivider);
    for (const item of section.items) {
      lines.push(`◈ *${cleanCommand(item.cmd)}*`, `  └ ${item.desc}`);
    }
  }

  // ── Rotating Premium Tip Section ──
  lines.push(
    '',
    safeDivider,
    '◈ *PREMIUM HIGHLIGHT*',
    safeDivider,
  );
  lines.push(`◉ ${getPremiumTip()}`);

  lines.push(
    '',
    safeDivider,
    '⟦ Awaiting Operator Command... ⟧'
  );

  return lines.join('\n').trim();
}

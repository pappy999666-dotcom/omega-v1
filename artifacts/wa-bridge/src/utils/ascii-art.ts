// ============================================================
// WA-Bridge — ASCII Art & WhatsApp Message Styling
// WhatsApp supports *bold*, _italic_, ~strikethrough~, ```code```
// ============================================================

export interface AsciiBoxOptions {
  title: string;
  rows: [string, string][];
  footer?: string;
  emoji?: string;
  width?: number;
}

/**
 * Renders a bordered ASCII box for WhatsApp messages.
 *
 * Example output:
 * ╔══════════════════════╗
 * ║   🤖  BOT CONTROL   ║
 * ╠══════════════════════╣
 * ║ Status    │ Online   ║
 * ╚══════════════════════╝
 */
export function asciiBox(opts: AsciiBoxOptions): string {
  const { title, rows, footer, emoji = '', width = 30 } = opts;

  const inner = width - 2;
  const padRow = (s: string) => s.padEnd(inner).slice(0, inner);
  const hLine = '═'.repeat(inner);
  const midLine = `╠${hLine}╣`;

  const titleStr = emoji ? `${emoji}  ${title}  ${emoji}` : `  ${title}  `;
  const centeredTitle = titleStr.padStart((inner + titleStr.length) / 2).padEnd(inner);

  const lines: string[] = [
    `╔${hLine}╗`,
    `║${centeredTitle}║`,
    midLine,
  ];

  for (const [label, value] of rows) {
    const combined = ` ${label.padEnd(12)} │ ${value}`;
    lines.push(`║${padRow(combined)}║`);
  }

  if (footer) {
    lines.push(midLine);
    const footerStr = `  ${footer}  `;
    const centeredFooter = footerStr.padStart((inner + footerStr.length) / 2).padEnd(inner);
    lines.push(`║${centeredFooter}║`);
  }

  lines.push(`╚${hLine}╝`);
  return lines.join('\n');
}

/**
 * Simple divider line.
 */
export const divider = (char = '─', len = 30) => char.repeat(len);

/**
 * Result summary box for mass operations (allstatus, allchat, joinall).
 */
export function resultBox(opts: {
  op: string;
  success: number;
  failed: number;
  skipped: number;
  rateLimited: number;
  duration: string;
}): string {
  return asciiBox({
    title: opts.op.toUpperCase() + ' RESULT',
    emoji: '📊',
    rows: [
      ['✅ Success', String(opts.success)],
      ['❌ Failed', String(opts.failed)],
      ['⏭ Skipped', String(opts.skipped)],
      ['🚦 R-Limited', String(opts.rateLimited)],
      ['⏱ Duration', opts.duration],
    ],
  });
}

/**
 * Session info box.
 */
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
      ['Phone', opts.phone],
      ['Status', opts.status.toUpperCase()],
      ['Groups', String(opts.groups)],
    ],
  });
}

/**
 * Bold text for WhatsApp.
 */
export const bold = (s: string) => `*${s}*`;

/**
 * Italic text for WhatsApp.
 */
export const italic = (s: string) => `_${s}_`;

/**
 * Monospace/code text for WhatsApp.
 */
export const mono = (s: string) => `\`\`\`${s}\`\`\``;

/**
 * Strikethrough for WhatsApp.
 */
export const strike = (s: string) => `~${s}~`;

/**
 * Format a menu for WhatsApp.
 */
export function whatsappMenu(
  title: string,
  sections: { heading: string; items: { cmd: string; desc: string }[] }[]
): string {
  const lines: string[] = [
    bold(`╔══ ${title.toUpperCase()} ══╗`),
    '',
  ];

  for (const section of sections) {
    lines.push(bold(`▌ ${section.heading}`));
    for (const item of section.items) {
      lines.push(`  ${bold(item.cmd)} — ${italic(item.desc)}`);
    }
    lines.push('');
  }

  lines.push(italic('Powered by WA-Bridge 🚀'));
  return lines.join('\n');
}

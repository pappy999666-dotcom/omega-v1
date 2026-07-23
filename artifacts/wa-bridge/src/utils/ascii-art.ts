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

/** Lightweight spacing divider; intentionally contains no box-drawing artwork. */
export const divider = (): string => '';

export function successCard(title: string, message: string, rows: [string, string][] = []): string {
  return asciiBox({ title, emoji: '✅', rows, footer: message });
}

export function warningCard(title: string, message: string, rows: [string, string][] = []): string {
  return asciiBox({ title, emoji: '⚠️', rows, footer: message });
}

export function errorCard(title: string, message: string, details?: string): string {
  return [asciiBox({ title, emoji: '❌', rows: [], footer: message }), details ? `\n${mono(details)}` : '']
    .filter(Boolean)
    .join('\n');
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
    title: `${opts.op.toUpperCase()} RESULT`,
    emoji: '📊',
    rows: [
      ['Successful', String(opts.success)],
      ['Failed', String(opts.failed)],
      ['Skipped', String(opts.skipped)],
      ['Rate limited', String(opts.rateLimited)],
      ['Duration', opts.duration],
    ],
    footer: 'Operation complete.',
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

export function whatsappMenu(
  title: string,
  sections: { heading: string; items: { cmd: string; desc: string }[] }[]
): string {
  const lines: string[] = [`${bold(title.toUpperCase())}`, '', quote('Choose a command below. Commands can also be triggered from bound stickers.'), ''];
  for (const section of sections) {
    lines.push(bold(section.heading));
    for (const item of section.items) lines.push(`${bold(item.cmd)}\n${italic(item.desc)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

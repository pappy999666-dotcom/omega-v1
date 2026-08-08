// ============================================================
// WA-Bridge — QC Sticker (Quote / Custom Text Sticker)
//
// `.qc <text> [--bg <preset|#hex|#hex1,#hex2>]` renders the
// provided text as a bold, premium sticker using the installed
// sharp image pipeline (SVG → WebP) and sends it through the
// Baileys sticker path.
//
// Background control:
//   • default                     → transparent background
//   • --bg dark|ocean|fire|…      → built-in gradient presets
//   • --bg #rrggbb                → solid color
//   • --bg #rrggbb,#rrggbb        → custom gradient
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { asciiBox, errorCard } from '../../utils/ascii-art.js';
import { logger } from '../../utils/logger.js';
import { addStickerMetadata, validateWebP } from './sticker.js';
import sharp from 'sharp';

const CANVAS = 512;

// ── Background presets ──────────────────────────────────────

export interface QcBackground {
  kind: 'transparent' | 'solid' | 'gradient';
  from: string; // used for solid too
  to?: string;
  label: string;
}

export const QC_BG_PRESETS: Record<string, { from: string; to?: string }> = {
  dark: { from: '#1a1a2e', to: '#16213e' },
  ocean: { from: '#0f2027', to: '#2c5364' },
  fire: { from: '#2b0a0a', to: '#7f1d1d' },
  sunset: { from: '#2d1b69', to: '#7f1d5b' },
  forest: { from: '#052e16', to: '#14532d' },
  royal: { from: '#1e3a8a', to: '#312e81' },
  mono: { from: '#111111', to: '#333333' },
  crimson: { from: '#4c0519', to: '#881337' },
  emerald: { from: '#022c22', to: '#065f46' },
  gold: { from: '#3b2f00', to: '#784b03' },
};

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

function normalizeHex(value: string): string | null {
  const v = value.trim();
  if (!HEX_RE.test(v)) return null;
  return v.startsWith('#') ? v : `#${v}`;
}

/** Parse an optional `--bg <value>` / `--bg=<value>` flag out of the text. */
export function parseBgFlag(text: string): { text: string; bg: QcBackground } {
  const tokens = text.split(/\s+/);
  const kept: string[] = [];
  let bg: QcBackground = { kind: 'transparent', from: '#00000000', label: 'transparent' };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const eq = tok.match(/^--bg=(.+)$/);
    if (tok === '--bg' && tokens[i + 1] !== undefined) {
      const raw = tokens[i + 1]!;
      const resolved = resolveBg(raw);
      if (resolved) {
        bg = resolved;
        i++; // consume the value token
        continue;
      }
    } else if (eq) {
      const resolved = resolveBg(eq[1]!);
      if (resolved) {
        bg = resolved;
        continue;
      }
    }
    kept.push(tok);
  }

  return { text: kept.join(' ').trim(), bg };
}

function resolveBg(raw: string): QcBackground | null {
  const preset = QC_BG_PRESETS[raw.toLowerCase()];
  if (preset) {
    return { kind: 'gradient', from: preset.from, to: preset.to, label: raw.toLowerCase() };
  }
  if (raw.toLowerCase() === 'transparent' || raw.toLowerCase() === 'none') {
    return { kind: 'transparent', from: '#00000000', label: 'transparent' };
  }
  // gradient: #aabbcc,#ddeeff
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length === 2) {
    const a = normalizeHex(parts[0]!);
    const b = normalizeHex(parts[1]!);
    if (a && b) return { kind: 'gradient', from: a, to: b, label: `${a},${b}` };
  }
  const single = normalizeHex(raw);
  if (single) return { kind: 'solid', from: single, label: single };
  return null;
}

// ── Text layout helpers ─────────────────────────────────────

function glyphWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x2ffff)
  ) {
    return 2;
  }
  return 1;
}

const PADDING = 48;
const MAX_TEXT_W = CANVAS - PADDING * 2;

/** Approximate rendered width of a string in em units (latin ≈ 0.55em, wide ≈ 1.1em). */
function emWidth(value: string): number {
  return [...value].reduce((sum, ch) => sum + (glyphWidth(ch) / 2) * 1.1, 0);
}

export function layoutLines(text: string): { lines: string[]; fontSize: number } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const words = normalized ? normalized.split(' ') : [''];

  const maxWordLen = Math.max(...words.map((w) => [...w].length), 1);
  let fontSize = 110;
  if (maxWordLen > 8) fontSize = 96;
  if (maxWordLen > 12) fontSize = 80;
  if (maxWordLen > 18) fontSize = 64;
  if (maxWordLen > 26) fontSize = 48;
  if (maxWordLen > 38) fontSize = 36;

  const minEm = emWidth('M');
  const maxCharsPerLine = Math.max(1, Math.floor(MAX_TEXT_W / (36 * minEm)));
  const hardBreak = (value: string): string[] => {
    const chars = [...value];
    const parts: string[] = [];
    for (let i = 0; i < chars.length; i += maxCharsPerLine) {
      parts.push(chars.slice(i, i + maxCharsPerLine).join(''));
    }
    return parts;
  };
  const brokenWords = words.flatMap((w) => (w.length > maxCharsPerLine ? hardBreak(w) : [w]));

  for (let attempt = 0; attempt < 10; attempt++) {
    const maxEm = MAX_TEXT_W / fontSize;
    const lines: string[] = [];
    let current = '';
    let currentEm = 0;

    for (const word of brokenWords) {
      const wordEm = emWidth(word);
      const sepEm = current ? emWidth(' ') : 0;
      if (current && currentEm + sepEm + wordEm > maxEm) {
        lines.push(current);
        current = word;
        currentEm = wordEm;
      } else {
        current = current ? `${current} ${word}` : word;
        currentEm += sepEm + wordEm;
      }
    }
    if (current) lines.push(current);

    const lineHeight = Math.ceil(fontSize * 1.15);
    if (lines.length * lineHeight <= CANVAS - PADDING * 2 || lines.length <= 1) {
      return { lines, fontSize };
    }
    fontSize = Math.max(20, fontSize - 10);
  }

  return { lines: [normalized], fontSize: 32 };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildSvg(text: string, bg?: QcBackground): string {
  const { lines, fontSize } = layoutLines(text);
  const lineHeight = Math.ceil(fontSize * 1.15);
  const blockHeight = lines.length * lineHeight;
  const startY = (CANVAS - blockHeight) / 2 + lineHeight / 2;

  const tspans = lines
    .map((line, i) => {
      const y = Math.round(startY + i * lineHeight);
      return `      <tspan x="256" y="${y}" text-anchor="middle">${escapeXml(line)}</tspan>`;
    })
    .join('\n');

  const background = ((): string => {
    if (!bg || bg.kind === 'transparent') return '';
    if (bg.kind === 'solid') {
      return `  <rect width="${CANVAS}" height="${CANVAS}" rx="96" fill="${bg.from}"/>\n  <rect x="6" y="6" width="${CANVAS - 12}" height="${CANVAS - 12}" rx="90" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="4"/>\n`;
    }
    return `  <defs>
    <linearGradient id="qcBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg.from}"/>
      <stop offset="100%" stop-color="${bg.to}"/>
    </linearGradient>
  </defs>
  <rect width="${CANVAS}" height="${CANVAS}" rx="96" fill="url(#qcBg)"/>
  <rect x="6" y="6" width="${CANVAS - 12}" height="${CANVAS - 12}" rx="90" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="4"/>\n`;
  })();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
${background}  <defs>
    <linearGradient id="qcText" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#9fd8ff"/>
    </linearGradient>
    <filter id="qcGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#0b1a3a" flood-opacity="0.55"/>
    </filter>
  </defs>
  <text font-family="'DejaVu Sans', 'Droid Sans Fallback', sans-serif" font-weight="bold" font-size="${fontSize}"
    fill="url(#qcText)" stroke="#0b1a3a" stroke-width="6" paint-order="stroke" stroke-linejoin="round" filter="url(#qcGlow)">
${tspans}
  </text>
</svg>`;
  return svg;
}

// ── Public API ──────────────────────────────────────────────

export interface QcOptions {
  packname?: string;
  author?: string;
}

export async function cmdQcSticker(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  text: string,
  config: QcOptions = {}
): Promise<void> {
  const send = (body: string, options: Record<string, unknown> = {}): Promise<unknown> =>
    PreviewManager.send(socket as any, groupJid, body, { sessionId, telegramId, ...options });

  try {
    const trimmed = text.trim();
    if (!trimmed) {
      await send(asciiBox({
        title: 'QC STICKER',
        emoji: '✏️',
        moduleIdentity: 'QC STICKER',
        rows: [['Usage', '.qc <text> [--bg <preset|#hex|#hex,#hex>]']],
        footer: 'Generate a bold premium text sticker, e.g. .qc TAG --bg ocean',
      }));
      return;
    }

    const { text: cleanText, bg } = parseBgFlag(trimmed);
    if (!cleanText) {
      await send(asciiBox({
        title: 'QC STICKER',
        emoji: '✏️',
        moduleIdentity: 'QC STICKER',
        rows: [['Usage', '.qc <text> [--bg <preset|#hex|#hex,#hex>]']],
        footer: 'The --bg flag needs text, e.g. .qc OMEGA --bg fire',
      }));
      return;
    }

    const svg = buildSvg(cleanText, bg);
    let stickerBuffer = await sharp(Buffer.from(svg))
      .resize(CANVAS, CANVAS, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .webp({ quality: 85 })
      .toBuffer();

    validateWebP(stickerBuffer);
    stickerBuffer = addStickerMetadata(stickerBuffer, config.packname || 'PAPPY', config.author || 'OMEGA');
    validateWebP(stickerBuffer);

    await PreviewManager.send(socket as any, groupJid, '', {
      media: {
        type: 'sticker',
        buffer: stickerBuffer,
        mimetype: 'image/webp',
      },
      sessionId,
      telegramId,
    });

    await send(asciiBox({
      title: 'QC STICKER',
      emoji: '✅',
      moduleIdentity: 'QC STICKER',
      rows: [
        ['Text', cleanText.length > 40 ? `${cleanText.slice(0, 40)}…` : cleanText],
        ['Background', bg.label],
        ['Status', 'Sticker created successfully.'],
      ],
    }));
  } catch (err) {
    logger.error('[QC] Failed to generate sticker', { err: String(err) });
    await send(errorCard('QC STICKER', 'Could not generate the sticker.', String(err), 'QC STICKER'));
  }
}

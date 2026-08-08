// ============================================================
// WA-Bridge — QC Sticker (Quote / Custom Text Sticker)
//
// `.qc <text>` renders the provided text as a bold, premium
// sticker using the installed sharp image pipeline (SVG → WebP)
// and sends it through the Baileys sticker path.
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { asciiBox, errorCard } from '../../utils/ascii-art.js';
import { logger } from '../../utils/logger.js';
import { addStickerMetadata, validateWebP } from './sticker.js';
import sharp from 'sharp';

const CANVAS = 512;

// ── Text layout helpers ─────────────────────────────────────
// Rough per-glyph width table used to wrap/fit text before SVG
// rendering. Emoji and wide (CJK) glyphs count as 2 units so
// multi-line layouts never overflow the canvas.

function glyphWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  // Wide ranges: CJK, fullwidth, emoji, combining marks are wide-ish
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK Radicals → Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compat ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compat forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
    (code >= 0x1f300 && code <= 0x1faff) || // emoji + symbols
    (code >= 0x20000 && code <= 0x2ffff)   // CJK ext B+
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

  // Base font size scales down with the longest word.
  const maxWordLen = Math.max(...words.map((w) => [...w].length), 1);
  let fontSize = 110;
  if (maxWordLen > 8) fontSize = 96;
  if (maxWordLen > 12) fontSize = 80;
  if (maxWordLen > 18) fontSize = 64;
  if (maxWordLen > 26) fontSize = 48;
  if (maxWordLen > 38) fontSize = 36;

  // Hard-break any single word longer than a full line at the smallest size,
  // so unbroken strings can never overflow the canvas.
  const minEm = emWidth('M'); // widest latin glyph ≈ 0.55em
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
    // Maximum line width expressed in em units at the current font size.
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

  // Last resort: single line, aggressive shrink.
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

export function buildSvg(text: string): string {
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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="qcText" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#9fd8ff"/>
    </linearGradient>
    <filter id="qcGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#0b1a3a" flood-opacity="0.55"/>
    </filter>
  </defs>
  <!-- Transparent background — the gradient text + dark stroke keeps it readable on any wallpaper. -->
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
        rows: [['Usage', '.qc <text>']],
        footer: 'Generate a bold premium text sticker, e.g. .qc TAG',
      }));
      return;
    }

    const svg = buildSvg(trimmed);
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
        ['Text', trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed],
        ['Status', 'Sticker created successfully.'],
      ],
    }));
  } catch (err) {
    logger.error('[QC] Failed to generate sticker', { err: String(err) });
    await send(errorCard('QC STICKER', 'Could not generate the sticker.', String(err), 'QC STICKER'));
  }
}

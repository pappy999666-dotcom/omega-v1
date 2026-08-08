// ============================================================
// WA-Bridge — TG Sticker (Telegram Sticker Downloader)
//
// `.tg <link>` resolves a Telegram sticker pack link through the
// Telegram Bot API (getStickerSet → getFile → download), converts
// the chosen sticker into a WhatsApp-compatible WebP sticker and
// sends it. Animated (TGS/Lottie) stickers cannot be converted by
// the installed dependencies, so they fail with a clear error.
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { asciiBox, errorCard, warningCard } from '../../utils/ascii-art.js';
import { logger } from '../../utils/logger.js';
import { addStickerMetadata, validateWebP } from './sticker.js';
import sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execPromise = promisify(exec);
const API_BASE = 'https://api.telegram.org';
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_PACK_PREVIEW = 15;

// ── Link parsing ────────────────────────────────────────────

export interface TgStickerRef {
  packName: string;
  /** Optional 1-based selection provided in the same message. */
  selection?: number;
  selectionEmoji?: string;
}

/**
 * Parse a Telegram sticker link.
 * Accepts: t.me/addstickers/<name>, t.me/addsticker/<name>,
 * telegram.me/addstickers/<name>, tg://addstickers?set=<name>
 * and bare pack names. Returns null for anything else.
 */
export function parseTgLink(raw: string): TgStickerRef | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  // Full link forms
  const linkMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:addsticker|addstickers)\/([A-Za-z0-9_]{1,64})(?:\s+(\d{1,3}))?$/i
  );
  if (linkMatch) {
    return {
      packName: linkMatch[1]!,
      selection: linkMatch[2] ? Math.max(1, parseInt(linkMatch[2]!, 10)) : undefined,
    };
  }

  // tg:// deep link
  const deepMatch = trimmed.match(/^tg:\/\/addstickers\?set=([A-Za-z0-9_]{1,64})(?:\s+(\d{1,3}))?$/i);
  if (deepMatch) {
    return {
      packName: deepMatch[1]!,
      selection: deepMatch[2] ? Math.max(1, parseInt(deepMatch[2]!, 10)) : undefined,
    };
  }

  // Bare pack name with optional index
  const bareMatch = trimmed.match(/^([A-Za-z0-9_]{1,64})(?:\s+(\d{1,3}))?$/);
  if (bareMatch) {
    return {
      packName: bareMatch[1]!,
      selection: bareMatch[2] ? Math.max(1, parseInt(bareMatch[2]!, 10)) : undefined,
    };
  }

  return null;
}

// ── Bot API helpers ─────────────────────────────────────────

interface TgApiSticker {
  file_id: string;
  emoji?: string;
  width?: number;
  height?: number;
  type?: string;
}

interface TgApiSet {
  name: string;
  title?: string;
  is_animated?: boolean;
  is_video?: boolean;
  stickers: TgApiSticker[];
}

async function botApi<T>(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw Object.assign(new Error('TELEGRAM_BOT_TOKEN is not configured — the TG sticker engine is unavailable.'), {
      code: 'TG_NO_TOKEN',
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    const json = (await res.json()) as { ok: boolean; description?: string; result?: T };
    if (!json.ok || !json.result) {
      throw new Error(json.description ?? `Telegram API error (${method})`);
    }
    return json.result;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Telegram API request timed out.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // hard cap — never buffer oversized media

async function downloadFile(filePath: string, knownSize?: number): Promise<Buffer> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  if (knownSize !== undefined && knownSize > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Sticker is too large (${Math.round(knownSize / 1024 / 1024)} MB) — the bot only downloads up to 25 MB.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/file/bot${token}/${filePath}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Sticker is too large (${Math.round(declared / 1024 / 1024)} MB) — the bot only downloads up to 25 MB.`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Sticker is too large (${Math.round(buffer.length / 1024 / 1024)} MB) — the bot only downloads up to 25 MB.`);
    }
    return buffer;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Sticker download timed out.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Conversion ──────────────────────────────────────────────

async function staticToSticker(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .webp({ quality: 85 })
    .toBuffer();
}

async function videoToSticker(buffer: Buffer): Promise<Buffer> {
  // Reuse the same ffmpeg animated-WebP pipeline as the local sticker engine.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sticker-'));
  const inputPath = path.join(tempDir, 'input.webm');
  const outputPath = path.join(tempDir, 'output.webp');
  try {
    fs.writeFileSync(inputPath, buffer);
    const ffmpegCmd = [
      `ffmpeg -y -i "${inputPath}"`,
      `-vcodec libwebp`,
      `-filter:v "scale='if(gt(iw,ih),512,-1)':'if(gt(iw,ih),-1,512)',`,
      `pad=512:512:(512-iw)/2:(512-ih)/2:color=#00000000"`,
      `-lossless 0 -quality 80 -loop 0 -preset default`,
      `-an -fps_mode passthrough`,
      `"${outputPath}"`,
    ].join(' ');
    try {
      await execPromise(ffmpegCmd);
    } catch (ffmpegErr) {
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw new Error(`ffmpeg conversion failed: ${String(ffmpegErr).slice(0, 300)}`);
      }
      logger.warn('[TG] ffmpeg exited with warnings (output still valid)', { err: String(ffmpegErr).slice(0, 200) });
    }
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 12) {
      throw new Error('Animated conversion produced no output.');
    }
    return Buffer.from(fs.readFileSync(outputPath));
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Public API ──────────────────────────────────────────────

export async function cmdTgSticker(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  rawInput: string
): Promise<void> {
  const send = (body: string, options: Record<string, unknown> = {}): Promise<unknown> =>
    PreviewManager.send(socket as any, groupJid, body, { sessionId, telegramId, ...options });

  const ref = parseTgLink(rawInput);
  if (!ref) {
    await send(warningCard(
      'TG STICKER',
      'Provide a Telegram sticker link, e.g. .tg https://t.me/addstickers/StickerPackName',
      [],
      'TG STICKER'
    ));
    return;
  }

  try {
    const pack = await botApi<TgApiSet>('getStickerSet', { name: ref.packName });
    const stickers = pack.stickers ?? [];

    if (!ref.selection) {
      // Pack overview — list a preview and instruct how to select.
      if (stickers.length === 0) {
        await send(errorCard('TG STICKER', 'This sticker pack is empty.', undefined, 'TG STICKER'));
        return;
      }
      const rows: [string, string][] = stickers
        .slice(0, MAX_PACK_PREVIEW)
        .map((s, i) => [`#${i + 1}`, `${s.emoji ?? '🎯'} (${s.width ?? '?'}×${s.height ?? '?'})`]);
      if (stickers.length > MAX_PACK_PREVIEW) {
        rows.push(['…', `+${stickers.length - MAX_PACK_PREVIEW} more`]);
      }
      await send(asciiBox({
        title: 'TG STICKER PACK',
        emoji: '📦',
        moduleIdentity: 'TG STICKER',
        rows: [
          ['Pack', pack.title ?? ref.packName],
          ['Stickers', `${stickers.length} (${pack.is_animated ? 'animated' : pack.is_video ? 'video' : 'static'})`],
          ...rows,
        ],
        footer: `Reply with .tg ${ref.packName} <number> to download that sticker.`,
      }));
      return;
    }

    // Direct selection by index.
    const idx = ref.selection - 1;
    if (idx >= stickers.length) {
      await send(errorCard('TG STICKER', `Sticker #${ref.selection} not found. The pack has ${stickers.length} stickers.`, undefined, 'TG STICKER'));
      return;
    }
    const sticker = stickers[idx]!;

    // Animated (Lottie/TGS) stickers cannot be rasterized by the installed
    // dependencies — fail clearly instead of pretending it worked.
    if (pack.is_animated) {
      await send(errorCard(
        'TG STICKER',
        'Animated Telegram stickers (TGS/Lottie) are not supported: the installed image pipeline cannot convert this format.',
        'Try a static or video sticker pack instead.',
        'TG STICKER'
      ));
      return;
    }

    const file = await botApi<{ file_path: string; file_size?: number }>('getFile', { file_id: sticker.file_id });
    if (!file?.file_path) {
      throw new Error('Telegram could not resolve the sticker file.');
    }

    const rawBuffer = await downloadFile(file.file_path, file.file_size);
    const ext = path.extname(file.file_path).toLowerCase();

    let stickerBuffer: Buffer;
    if (ext === '.webm' || ext === '.mp4' || pack.is_video) {
      stickerBuffer = await videoToSticker(rawBuffer);
    } else {
      stickerBuffer = await staticToSticker(rawBuffer);
    }

    validateWebP(stickerBuffer);
    stickerBuffer = addStickerMetadata(stickerBuffer, pack.title ?? ref.packName, 'Telegram');
    validateWebP(stickerBuffer);

    await PreviewManager.send(socket as any, groupJid, '', {
      media: { type: 'sticker', buffer: stickerBuffer, mimetype: 'image/webp' },
      sessionId,
      telegramId,
    });

    await send(asciiBox({
      title: 'TG STICKER',
      emoji: '✅',
      moduleIdentity: 'TG STICKER',
      rows: [
        ['Pack', pack.title ?? ref.packName],
        ['Sticker', `#${ref.selection}`],
        ['Format', pack.is_video ? 'video → animated' : 'static webp'],
        ['Status', 'Sticker downloaded & converted.'],
      ],
    }));
  } catch (err) {
    const error = err as { code?: string; message?: string };
    logger.error('[TG] Sticker download failed', { err: error.message ?? String(err) });
    if (error.code === 'TG_NO_TOKEN') {
      await send(errorCard('TG STICKER', 'Telegram integration is not configured.', 'Set TELEGRAM_BOT_TOKEN in the bridge environment.', 'TG STICKER'));
      return;
    }
    const message = (error.message ?? String(err)).slice(0, 200);
    await send(errorCard('TG STICKER', 'Could not download or convert the Telegram sticker.', message, 'TG STICKER'));
  }
}

// ============================================================
// WA-Bridge — TG Sticker (Telegram Sticker Downloader)
//
// `.tg <link> [number]` resolves Telegram sticker content and
// converts it into a WhatsApp-compatible WebP sticker:
//
//   • Pack links  t.me/addstickers/<name>        → Bot API getStickerSet
//   • Pack names  <name> [number]                → Bot API getStickerSet
//   • Post links  t.me/<channel>/<id>            → t.me/s/<channel> feed
//     (public sticker posts; animated TGS fails clearly)
//
// Animated (TGS/Lottie) stickers cannot be converted by the
// installed dependencies, so they fail with a clear error.
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { asciiBox, errorCard, warningCard } from '../../utils/ascii-art.js';
import { logger } from '../../utils/logger.js';
import { addStickerMetadata, validateWebP } from './sticker.js';
import { singleSelectButton, type NativeListRow, type NativeListSection } from '../utils/native-rich.js';
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
const PICKER_ROWS = 10; // WhatsApp single_select sheet: 10 rows/section, 10 sections
const PICKER_SECTIONS = 3; // → up to 30 quick picks per sheet

// ── Link parsing ────────────────────────────────────────────

export type TgStickerRef =
  | { kind: 'pack'; packName: string; selection?: number }
  | { kind: 'post'; username: string; postId: string };

/**
 * Parse a Telegram sticker link.
 * Accepts pack links (addstickers/addsticker/telegram.me/tg://), bare pack
 * names with an optional 1-based index, and individual post links
 * (t.me/<channel>/<id>). Returns null for anything else.
 */
export function parseTgLink(raw: string): TgStickerRef | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  // Full pack link forms
  const linkMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:addsticker|addstickers)\/([A-Za-z0-9_]{1,64})(?:\s+(\d{1,3}))?$/i
  );
  if (linkMatch) {
    return {
      kind: 'pack',
      packName: linkMatch[1]!,
      selection: linkMatch[2] ? Math.max(1, parseInt(linkMatch[2]!, 10)) : undefined,
    };
  }

  // tg:// deep link
  const deepMatch = trimmed.match(/^tg:\/\/addstickers\?set=([A-Za-z0-9_]{1,64})(?:\s+(\d{1,3}))?$/i);
  if (deepMatch) {
    return {
      kind: 'pack',
      packName: deepMatch[1]!,
      selection: deepMatch[2] ? Math.max(1, parseInt(deepMatch[2]!, 10)) : undefined,
    };
  }

  // Individual post link: t.me/<channel>/<id> (also t.me/s/<channel>/<id>)
  const postMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_]{1,64})\/(\d{1,15})(?:\?[^\s]*)?$/i
  );
  if (postMatch) {
    return { kind: 'post', username: postMatch[1]!, postId: postMatch[2]! };
  }

  // Bare pack name with optional index
  const bareMatch = trimmed.match(/^([A-Za-z0-9_]{1,64})(?:\s+(\d{1,3}))?$/);
  if (bareMatch) {
    return {
      kind: 'pack',
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

async function httpGetText(url: string, timeoutMs = 15_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Telegram page request failed (HTTP ${res.status}).`);
    return await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Telegram page request timed out.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // hard cap — never buffer oversized media

/** Stream-safe fetch of an absolute URL with timeout + size caps (post media). */
async function downloadDirect(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: controller.signal,
    });
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

// ── Post feed resolution (t.me/<channel>/<id>) ──────────────
// The public `t.me/s/<channel>` feed embeds sticker media per post.
// We locate the target post block by its data-post attribute and
// extract the media URL (animated → .tgs, video → .webm, static → .webp).

export interface PostMedia {
  kind: 'animated' | 'video' | 'static';
  url: string;
}

export function extractPostMedia(feedHtml: string, username: string, postId: string): PostMedia | null {
  const postKey = `${username}/${postId}`;
  const idx = feedHtml.indexOf(`data-post="${postKey}"`);
  if (idx === -1) return null;
  // Bound the block to THIS post — cut at the next post block (or the end of
  // the widget wrapper) so neighbouring posts' media can never leak in.
  const nextPost = feedHtml.indexOf('data-post="', idx + postKey.length + 2);
  const end = nextPost === -1 ? feedHtml.length : nextPost;
  const block = feedHtml.slice(idx, Math.min(end, idx + 12_000));

  // Animated: <source type="application/x-tgsticker" srcset="…tgs…">
  const tgs = block.match(/application\/x-tgsticker"[^>]*srcset="([^"]+\.tgs[^"]*)"/);
  if (tgs) return { kind: 'animated', url: tgs[1]!.replace(/&amp;/g, '&') };

  // Video: <video … src="…webm…">  (some clients embed <video> without class)
  const video = block.match(/<(?:video|source)[^>]*src(?:set)?="([^"]+\.webm[^"]*)"/i);
  if (video) return { kind: 'video', url: video[1]!.replace(/&amp;/g, '&') };

  // Static: <img … src="…webp…"> or <source type="image/webp" srcset="…">
  const webp = block.match(/src(?:set)?="([^"]+\.webp[^"]*)"/);
  if (webp) return { kind: 'static', url: webp[1]!.replace(/&amp;/g, '&') };

  // Generic CDN image (jpg/png served by telesco for some static posts)
  const img = block.match(/src="(https:\/\/cdn\d*\.telesco\.pe\/file\/[^"]+)"/);
  if (img) return { kind: 'static', url: img[1]!.replace(/&amp;/g, '&') };

  return null;
}

export async function resolvePostMedia(username: string, postId: string): Promise<PostMedia> {
  const feedUrl = `https://t.me/s/${encodeURIComponent(username)}`;
  const html = await httpGetText(feedUrl);
  if (!html || html.length < 500) {
    throw new Error('Channel feed is unavailable (private or deleted channel?).');
  }
  const media = extractPostMedia(html, username, postId);
  if (!media) {
    throw new Error('Sticker post not found in the channel feed (post may be private, deleted, or not a sticker).');
  }
  return media;
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

// ── Shared download + send (command path AND picker router) ─

export interface TgSendOptions {
  /** WhatsApp sticker pack name shown in the sticker metadata (default: pack title). */
  packname?: string;
  /** WhatsApp sticker author shown in the sticker metadata (default: 'Telegram'). */
  author?: string;
}

/**
 * Download and send a single pack sticker (1-based index) as a WhatsApp sticker.
 * Returns true on success. Shared by `.tg <pack> <n>` and the picker router.
 */
export async function downloadPackSticker(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  packName: string,
  selection: number,
  options: TgSendOptions = {}
): Promise<boolean> {
  const send = (body: string, opts: Record<string, unknown> = {}): Promise<unknown> =>
    PreviewManager.send(socket as any, groupJid, body, { sessionId, telegramId, ...opts });

  const pack = await botApi<TgApiSet>('getStickerSet', { name: packName });
  const stickers = pack.stickers ?? [];
  const idx = selection - 1;
  if (idx >= stickers.length) {
    await send(errorCard('TG STICKER', `Sticker #${selection} not found. The pack has ${stickers.length} stickers.`, undefined, 'TG STICKER'));
    return false;
  }
  const sticker = stickers[idx]!;

  if (pack.is_animated) {
    await send(errorCard(
      'TG STICKER',
      'Animated Telegram stickers (TGS/Lottie) are not supported: the installed image pipeline cannot convert this format.',
      'Try a static or video sticker pack instead.',
      'TG STICKER'
    ));
    return false;
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
  stickerBuffer = addStickerMetadata(stickerBuffer, options.packname ?? pack.title ?? packName, options.author ?? 'Telegram');
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
      ['Pack', pack.title ?? packName],
      ['Sticker', `#${selection}`],
      ['Format', pack.is_video ? 'video → animated' : 'static webp'],
      ['Status', 'Sticker downloaded & converted.'],
    ],
  }));
  return true;
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
    // ── Individual post link (t.me/<channel>/<id>) ──
    if (ref.kind === 'post') {
      const media = await resolvePostMedia(ref.username, ref.postId);
      if (media.kind === 'animated') {
        await send(errorCard(
          'TG STICKER',
          'This post is an animated Telegram sticker (TGS/Lottie), which the installed image pipeline cannot convert.',
          'Try a static or video sticker post instead.',
          'TG STICKER'
        ));
        return;
      }
      const rawBuffer = await downloadDirect(media.url);
      const stickerBuffer = media.kind === 'video' ? await videoToSticker(rawBuffer) : await staticToSticker(rawBuffer);
      const finalBuffer = addStickerMetadata(stickerBuffer, `@${ref.username}`, 'Telegram');
      validateWebP(finalBuffer);

      await PreviewManager.send(socket as any, groupJid, '', {
        media: { type: 'sticker', buffer: finalBuffer, mimetype: 'image/webp' },
        sessionId,
        telegramId,
      });
      await send(asciiBox({
        title: 'TG STICKER',
        emoji: '✅',
        moduleIdentity: 'TG STICKER',
        rows: [
          ['Source', `t.me/${ref.username}/${ref.postId}`],
          ['Format', media.kind === 'video' ? 'video → animated' : 'static'],
          ['Status', 'Sticker downloaded & converted.'],
        ],
      }));
      return;
    }

    // ── Pack link / bare name ──
    const pack = await botApi<TgApiSet>('getStickerSet', { name: ref.packName });
    const stickers = pack.stickers ?? [];

    if (!ref.selection) {
      if (stickers.length === 0) {
        await send(errorCard('TG STICKER', 'This sticker pack is empty.', undefined, 'TG STICKER'));
        return;
      }

      // Visual picker: native single_select sheet with quick picks, plus a
      // text fallback list for larger packs.
      const rows: NativeListRow[] = stickers.slice(0, PICKER_ROWS * PICKER_SECTIONS).map((s, i) => ({
        title: `${i + 1}. ${s.emoji ?? '🎯'}`,
        description: `${s.width ?? '?'}×${s.height ?? '?'}`,
        rowId: `tg:pick:${ref.packName}:${i + 1}`,
      }));
      const sections: NativeListSection[] = [];
      for (let s = 0; s < PICKER_SECTIONS && rows.length > 0; s++) {
        sections.push({
          title: `Stickers ${s * PICKER_ROWS + 1}–${Math.min((s + 1) * PICKER_ROWS, rows.length)}`,
          rows: rows.splice(0, PICKER_ROWS),
        });
      }

      const textRows: [string, string][] = stickers
        .slice(0, MAX_PACK_PREVIEW)
        .map((s, i) => [`#${i + 1}`, `${s.emoji ?? '🎯'} (${s.width ?? '?'}×${s.height ?? '?'})`]);
      if (stickers.length > MAX_PACK_PREVIEW) {
        textRows.push(['…', `+${stickers.length - MAX_PACK_PREVIEW} more`]);
      }

      const card = asciiBox({
        title: 'TG STICKER PACK',
        emoji: '📦',
        moduleIdentity: 'TG STICKER',
        rows: [
          ['Pack', pack.title ?? ref.packName],
          ['Stickers', `${stickers.length} (${pack.is_animated ? 'animated' : pack.is_video ? 'video' : 'static'})`],
          ...textRows,
        ],
        footer: 'Tap a sticker below to download it, or reply .tg <pack> <number>.',
      });
      await send(card, {
        extra: { buttons: [singleSelectButton(`📦 ${pack.title ?? ref.packName}`, sections)] },
      });
      return;
    }

    // Direct selection by index.
    await downloadPackSticker(socket, telegramId, sessionId, groupJid, ref.packName, ref.selection);
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

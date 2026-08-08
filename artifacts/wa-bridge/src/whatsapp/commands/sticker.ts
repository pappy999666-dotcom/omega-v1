import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { warningCard, errorCard } from '../../utils/ascii-art.js';
import { logger } from '../../utils/logger.js';
import sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execPromise = promisify(exec);

// ── VP8X flag bits (from WebP Container Specification) ─────────────────────
const VP8X_FLAG_EXIF      = 0x08; // Bit 3: Exif metadata present
const VP8X_FLAG_ALPHA     = 0x10; // Bit 4: Alpha channel used
const VP8X_FLAG_ANIMATION = 0x02; // Bit 1: Animation present

// ── Public API ─────────────────────────────────────────────────────────────

export async function cmdSticker(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  media: { buffer: Buffer; type: 'image' | 'video'; mimeType: string },
  config: { packname?: string; author?: string }
): Promise<void> {
  // Validate ffmpeg is available for video conversion
  if (media.type === 'video') {
    try {
      const { execSync } = await import('child_process');
      execSync('ffmpeg -version', { stdio: 'pipe' });
    } catch {
      logger.error('[Sticker] ffmpeg is not installed or not in PATH');
      await PreviewManager.send(
        socket as any,
        groupJid,
        errorCard(
          'STICKER FAILED',
          'ffmpeg is required for video→sticker conversion but was not found in PATH.',
          'Install ffmpeg: sudo apt install -y ffmpeg'
        ),
        { suppressPreview: true, sessionId, telegramId }
      );
      return;
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-'));
  const inputPath = path.join(tempDir, `input${media.type === 'video' ? '.mp4' : '.jpg'}`);
  const outputPath = path.join(tempDir, 'output.webp');

  try {
    fs.writeFileSync(inputPath, media.buffer);

    if (media.type === 'image') {
      // .ensureAlpha() guarantees alpha channel → sharp produces VP8X format
      // which is required for EXIF injection.
      await sharp(inputPath)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .webp({ quality: 80 })
        .toFile(outputPath);
    } else {
      // Animated sticker via ffmpeg → animated WebP
      // ffmpeg always writes progress to stderr; only fail if output is missing/empty.
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
        // ffmpeg exits non-zero even on success if it writes warnings;
        // only propagate if the output file was not created or is empty.
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
          throw new Error(`ffmpeg failed: ${String(ffmpegErr).slice(0, 300)}`);
        }
        logger.warn('[Sticker] ffmpeg exited with warnings (output still valid)', {
          err: String(ffmpegErr).slice(0, 200),
        });
      }
    }

    // Validate the WebP output before further processing
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 12) {
      throw new Error('WebP output is missing or too small — conversion failed silently.');
    }

    let stickerBuffer: Buffer = Buffer.from(fs.readFileSync(outputPath));

    // Validate RIFF/WEBP magic
    validateWebP(stickerBuffer);

    // Always inject sticker metadata — WhatsApp requires EXIF for "sticker
    // information" to be viewable, regardless of whether custom pack/author
    // names were provided.
    const packname = config.packname || 'PAPPY';
    const author   = config.author   || 'OMEGA';
    stickerBuffer = addStickerMetadata(stickerBuffer, packname, author);

    // Re-validate after injection
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

    // The generated sticker is the response. Do not send a second
    // "sticker created" confirmation bubble.
  } catch (err) {
    logger.error('[Sticker] Failed to create sticker', { err: String(err) });
    await PreviewManager.send(
      socket as any,
      groupJid,
      errorCard('STICKER FAILED', 'Could not convert media to sticker.', String(err)),
      { suppressPreview: true, sessionId, telegramId }
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

// ── WebP Validation ─────────────────────────────────────────────────────────

/**
 * Throws if the buffer is not a well-formed WebP file.
 */
export function validateWebP(buffer: Buffer): void {
  if (buffer.length < 12) {
    throw new Error(`WebP too small: ${buffer.length} bytes`);
  }
  if (buffer.slice(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error('Missing RIFF header — not a valid WebP');
  }
  if (buffer.slice(8, 12).toString('ascii') !== 'WEBP') {
    throw new Error('Missing WEBP magic — not a valid WebP container');
  }
}

// ── Sticker Metadata Injection ──────────────────────────────────────────────

/**
 * Injects WhatsApp-compatible sticker metadata into a WebP container.
 *
 * WhatsApp reads sticker pack information from a custom EXIF chunk embedded
 * in the WebP file.  The EXIF payload uses a non-standard TIFF structure that
 * all major WhatsApp sticker libraries converge on (wa-sticker-formatter,
 * @open-wa, venom-bot, etc.):
 *
 *   TIFF header  (8 bytes):  II + 0x002A magic + IFD offset = 8
 *   IFD count    (2 bytes):  1
 *   IFD entry   (12 bytes):
 *     tag    = 0x5741 (custom WA tag — not a standard EXIF/TIFF tag)
 *     type   = 7 (UNDEFINED — raw bytes)
 *     count  = JSON byte length (no null terminator)
 *     offset = 22 (points to byte 22 within the TIFF payload)
 *   JSON data at byte 22 of TIFF payload
 *
 * Important VP8X rules:
 *   - If VP8X is present:   update its flags to set the Exif bit (0x08),
 *                           then insert EXIF after VP8X (static) or at the
 *                           end of all chunks (animated).
 *   - If VP8X is absent:    create VP8X (has_exif flag + 512×512 canvas),
 *                           insert EXIF immediately after VP8X.
 */
export function addStickerMetadata(buffer: Buffer, packname: string, author: string): Buffer {
  // Verify WebP
  if (
    buffer.length < 12 ||
    buffer.slice(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.slice(8, 12).toString('ascii') !== 'WEBP'
  ) {
    logger.warn('[Sticker] addStickerMetadata: not a valid WebP — returning unchanged');
    return buffer;
  }

  // ── Build JSON payload ─────────────────────────────────────────────────
  const json = JSON.stringify({
    'sticker-pack-id': `com.omega.${sanitizeId(author)}.${sanitizeId(packname)}`,
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    'emojis': ['\u26a1'],
  });
  const jsonBuffer = Buffer.from(json, 'utf8');

  // ── Build TIFF/EXIF payload ────────────────────────────────────────────
  //
  // Byte layout (offsets within the TIFF payload):
  //   0-1:   II (little-endian marker)
  //   2-3:   0x002A (TIFF magic)
  //   4-7:   0x00000008 (IFD offset = 8)
  //   8-9:   0x0001 (1 IFD entry)
  //   10-11: 0x5741 (tag — custom WA)
  //   12-13: 0x0007 (type — UNDEFINED)
  //   14-17: jsonBuffer.length (count)
  //   18-21: 0x00000016 = 22 (offset to JSON data)
  //   22+:   JSON bytes
  //
  // Note: there is no "next IFD" 4-byte field between the IFD entry and the
  // data — the offset (22) lands exactly at the first byte after the header.
  // This matches the known-working format used by WhatsApp sticker libraries.

  const TIFF_HEADER_SIZE = 22; // bytes before JSON data
  const tiffPayload = Buffer.alloc(TIFF_HEADER_SIZE + jsonBuffer.length);

  tiffPayload.write('II', 0, 'ascii');           // LE byte order
  tiffPayload.writeUInt16LE(0x002A, 2);           // TIFF magic
  tiffPayload.writeUInt32LE(8, 4);               // IFD0 at byte 8
  tiffPayload.writeUInt16LE(1, 8);               // 1 IFD entry
  tiffPayload.writeUInt16LE(0x5741, 10);          // tag: custom WA
  tiffPayload.writeUInt16LE(7, 12);              // type: UNDEFINED
  tiffPayload.writeUInt32LE(jsonBuffer.length, 14); // count
  tiffPayload.writeUInt32LE(TIFF_HEADER_SIZE, 18);  // offset = 22
  jsonBuffer.copy(tiffPayload, TIFF_HEADER_SIZE);

  // ── Wrap in WebP EXIF chunk ────────────────────────────────────────────
  const exifChunkHeader = Buffer.alloc(8);
  exifChunkHeader.write('EXIF', 0, 'ascii');
  exifChunkHeader.writeUInt32LE(tiffPayload.length, 4);

  const exifChunk = Buffer.concat([exifChunkHeader, tiffPayload]);
  // WebP chunks must start on even offsets — pad with a zero byte if needed
  const paddedExif = exifChunk.length % 2 === 0
    ? exifChunk
    : Buffer.concat([exifChunk, Buffer.from([0x00])]);

  // ── Parse WebP chunk structure ─────────────────────────────────────────
  const firstChunkTag = buffer.slice(12, 16).toString('ascii');
  const hasVP8X       = firstChunkTag === 'VP8X';
  const isAnimated    = hasVP8X && (buffer.readUInt8(20) & VP8X_FLAG_ANIMATION) !== 0;

  let result: Buffer;

  if (hasVP8X) {
    // Work on a mutable copy so we can patch the VP8X flags in-place
    result = Buffer.from(buffer);
    // Set has_exif bit in VP8X flags (byte 20 = first byte of VP8X data)
    result.writeUInt8(result.readUInt8(20) | VP8X_FLAG_EXIF, 20);

    if (isAnimated) {
      // For animated WebP the EXIF chunk must come AFTER all ANMF chunks
      // (i.e., at the very end of the container).
      result = Buffer.concat([result, paddedExif]);
    } else {
      // For static VP8X WebP: insert EXIF right after the VP8X chunk
      const vp8xDataSize = result.readUInt32LE(16); // VP8X data length
      let insertAt = 12 + 8 + vp8xDataSize;         // after VP8X chunk+data
      if (insertAt % 2 !== 0) insertAt++;            // chunk padding

      result = Buffer.concat([
        result.slice(0, insertAt),
        paddedExif,
        result.slice(insertAt),
      ]);
    }
  } else {
    // No VP8X — must create one before the image data.
    // Canvas size: always 512×512 for stickers.
    const canvasW = 512;
    const canvasH = 512;

    // Detect alpha channel presence from the chunk type
    const hasAlpha = firstChunkTag !== 'VP8 '; // VP8L and VP8X+ALPH have alpha

    const vp8xFlags = VP8X_FLAG_EXIF | (hasAlpha ? VP8X_FLAG_ALPHA : 0);

    const vp8xChunk = Buffer.alloc(18); // 4 ID + 4 size + 10 data
    vp8xChunk.write('VP8X', 0, 'ascii');
    vp8xChunk.writeUInt32LE(10, 4);          // VP8X data is always 10 bytes
    vp8xChunk.writeUInt32LE(vp8xFlags, 8);   // flags (4 bytes)
    // Canvas width minus 1, stored as 3-byte LE integer
    vp8xChunk.writeUInt8( (canvasW - 1) & 0xFF,         12);
    vp8xChunk.writeUInt8(((canvasW - 1) >> 8) & 0xFF,   13);
    vp8xChunk.writeUInt8(((canvasW - 1) >> 16) & 0xFF,  14);
    // Canvas height minus 1, stored as 3-byte LE integer
    vp8xChunk.writeUInt8( (canvasH - 1) & 0xFF,         15);
    vp8xChunk.writeUInt8(((canvasH - 1) >> 8) & 0xFF,   16);
    vp8xChunk.writeUInt8(((canvasH - 1) >> 16) & 0xFF,  17);

    result = Buffer.concat([
      buffer.slice(0, 12),   // RIFF header
      vp8xChunk,             // new VP8X chunk
      paddedExif,            // EXIF chunk
      buffer.slice(12),      // original image chunks (VP8/VP8L)
    ]);
  }

  // Update RIFF file size (total length minus 8-byte RIFF/WEBP header)
  result.writeUInt32LE(result.length - 8, 4);

  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '') || 'omega';
}

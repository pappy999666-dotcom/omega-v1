import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { PreviewManager } from '../../preview-engine/index.js';
import { successCard, warningCard, errorCard } from '../../utils/ascii-art.js';
import { logger } from '../../utils/logger.js';
import sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execPromise = promisify(exec);

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
      await PreviewManager.send(socket as any, groupJid, errorCard('STICKER FAILED', 'ffmpeg is required for video→sticker conversion but was not found in PATH.', 'Install ffmpeg: sudo apt install -y ffmpeg'), {
        suppressPreview: true,
        sessionId,
        telegramId,
      });
      return;
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-'));
  const inputPath = path.join(tempDir, `input${media.type === 'video' ? '.mp4' : '.jpg'}`);
  const outputPath = path.join(tempDir, 'output.webp');

  try {
    fs.writeFileSync(inputPath, media.buffer);

    if (media.type === 'image') {
      await sharp(inputPath)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp()
        .toFile(outputPath);
    } else {
      // Video to animated sticker
      // Use ffmpeg to convert to webp with correct dimensions and fps
      const { stdout, stderr } = await execPromise(`ffmpeg -i "${inputPath}" -vcodec libwebp -filter:v "scale='if(gt(iw,ih),512,-1)':'if(gt(iw,ih),-1,512)',pad=512:512:(512-iw)/2:(512-ih)/2:color=#00000000" -lossless 1 -loop 0 -preset default -an -vsync 0 -s 512:512 "${outputPath}" 2>&1`);
      if (stderr && !stdout && !fs.existsSync(outputPath)) {
        throw new Error(`ffmpeg conversion failed: ${stderr.slice(0, 200)}`);
      }
    }

    let stickerBuffer = fs.readFileSync(outputPath);
    
    // Add metadata if provided
    if (config.packname || config.author) {
      stickerBuffer = addStickerMetadata(stickerBuffer, config.packname || 'PAPPY', config.author || 'OMEGA');
    }

    await PreviewManager.send(socket as any, groupJid, '', {
      media: {
        type: 'sticker',
        buffer: stickerBuffer,
        mimetype: 'image/webp',
      },
      sessionId,
      telegramId,
    });
    
    // Notify success to avoid silent UX
    await PreviewManager.send(socket as any, groupJid, successCard('STICKER CREATED', 'Your sticker has been generated and sent.', [], 'STICKER ENGINE'), {
      suppressPreview: true,
      sessionId,
      telegramId,
    });
  } catch (err) {
    logger.error('[Sticker] Failed to create sticker', { err: String(err) });
    await PreviewManager.send(socket as any, groupJid, errorCard('STICKER FAILED', 'Could not convert media to sticker.', String(err)), {
      suppressPreview: true,
      sessionId,
      telegramId,
    });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

/**
 * Injects WebP EXIF metadata for sticker pack name and author.
 * 
 * WhatsApp sticker metadata is stored in a WebP EXIF chunk using the
 * TIFF/EXIF format. The structure is:
 *   WebP Container:
 *     RIFF header (12 bytes)
 *     VP8X chunk (optional, 10 bytes) — must be first if present
 *     EXIF chunk (our injection point)
 *     VP8/VP8L chunk (image data)
 *   EXIF chunk payload (TIFF structure):
 *     TIFF header (8 bytes: byte order + magic 0x002A + IFD0 offset)
 *     IFD entry count (2 bytes: 1 entry)
 *     IFD entry (12 bytes: tag 0x010E, type SHORT(3), count=N, offset=0)
 *     Null terminator (2 bytes)
 *     JSON metadata (padded to even length)
 */
function addStickerMetadata(buffer: Buffer, packname: string, author: string): Buffer {
  // Verify this is a valid WebP file
  if (buffer.length < 12 || buffer.slice(0, 4).toString() !== 'RIFF' || buffer.slice(8, 12).toString() !== 'WEBP') {
    return buffer;
  }

  // Build the JSON metadata
  const json = {
    'sticker-pack-id': `com.omega.sticker.${Date.now()}`,
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    'emojis': ['\u26a1'],
  };
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');

  // Build the TIFF/EXIF header
  // TIFF header: byte order (II=0x4949 = little-endian) + magic (0x002A) + offset to first IFD (0x08)
  const tiffHeader = Buffer.from([
    0x49, 0x49, // Little-endian byte order
    0x2A, 0x00, // TIFF magic number
    0x08, 0x00, 0x00, 0x00, // Offset to IFD0 (right after the 8-byte TIFF header)
  ]);

  // IFD entry count: 1 entry
  const ifdEntryCount = Buffer.from([0x01, 0x00]);

  // IFD entry for ExifIFD (tag 0x8769 = 34665)
  // Tag: 0x8769 (ExifIFD)
  // Type: 4 (LONG)
  // Count: 1
  // Value/Offset: offset to the JSON data within the TIFF structure
  const jsonOffset = 8 + 2 + 12 + 2; // tiffHeader + entryCount + oneEntry + nullTerminator
  const ifdEntry = Buffer.alloc(12);
  ifdEntry.writeUInt16LE(0x8769, 0); // ExifIFD tag
  ifdEntry.writeUInt16LE(4, 2);     // Type: LONG
  ifdEntry.writeUInt32LE(1, 4);     // Count: 1
  ifdEntry.writeUInt32LE(jsonOffset, 8); // Offset to JSON data

  // Null terminator for IFD (next IFD offset = 0 means no more IFDs)
  const ifdTerminator = Buffer.from([0x00, 0x00]);

  // JSON data (pad to even length if needed)
  const paddedJsonBuffer = jsonBuffer.length % 2 === 0
    ? jsonBuffer
    : Buffer.concat([jsonBuffer, Buffer.from([0x00])]);

  // Assemble the complete EXIF payload
  const exifPayload = Buffer.concat([
    tiffHeader,
    ifdEntryCount,
    ifdEntry,
    ifdTerminator,
    paddedJsonBuffer,
  ]);

  // Build the WebP EXIF chunk
  // Chunk structure: 4-byte chunk ID + 4-byte chunk size (LE) + chunk data
  const exifChunkId = Buffer.from('EXIF');
  const exifChunkSize = Buffer.alloc(4);
  exifChunkSize.writeUInt32LE(exifPayload.length, 0);
  const exifChunk = Buffer.concat([exifChunkId, exifChunkSize, exifPayload]);

  // Pad EXIF chunk to even boundary if needed
  const paddedExifChunk = exifChunk.length % 2 === 0
    ? exifChunk
    : Buffer.concat([exifChunk, Buffer.from([0x00])]);

  // Find insertion point in the WebP container
  // RIFF header is 12 bytes (RIFF + size + WEBP)
  let insertOffset = 12;

  // If VP8X exists, it must come before EXIF
  // VP8X chunk is at offset 12, size is at offset 16, data is 10 bytes
  if (buffer.slice(12, 16).toString() === 'VP8X') {
    const vp8xSize = buffer.readUInt32LE(16);
    insertOffset = 12 + 8 + vp8xSize;
    if (insertOffset % 2 !== 0) insertOffset++; // Chunk padding
  }

  // Assemble the new WebP file
  const result = Buffer.concat([
    buffer.slice(0, insertOffset),
    paddedExifChunk,
    buffer.slice(insertOffset),
  ]);

  // Update RIFF size (total file size minus the 8-byte RIFF/WAVE header)
  result.writeUInt32LE(result.length - 8, 4);

  return result;
}

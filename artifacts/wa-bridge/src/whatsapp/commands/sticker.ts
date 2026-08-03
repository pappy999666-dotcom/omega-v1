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
      await execPromise(`ffmpeg -i "${inputPath}" -vcodec libwebp -filter:v "scale='if(gt(iw,ih),512,-1)':'if(gt(iw,ih),-1,512)',pad=512:512:(512-iw)/2:(512-ih)/2:color=#00000000" -lossless 1 -loop 0 -preset default -an -vsync 0 -s 512:512 "${outputPath}"`);
    }

    let stickerBuffer = fs.readFileSync(outputPath);
    
    // Add metadata if provided
    if (config.packname || config.author) {
      stickerBuffer = addStickerMetadata(stickerBuffer as any, config.packname || 'PAPPY', config.author || 'OMEGA') as any;
    }

    await PreviewManager.send(socket as any, groupJid, '', {
      media: {
        type: 'sticker',
        buffer: stickerBuffer,
      },
      sessionId,
      telegramId,
    });
    
    // Notify success to avoid silent UX
    await PreviewManager.send(socket as any, groupJid, successCard('STICKER CREATED', 'Your sticker has been generated and sent.', [], 'STICKER ENGINE'), {
      sessionId,
      telegramId,
    });
  } catch (err) {
    logger.error('[Sticker] Failed to create sticker', { err: String(err) });
    await PreviewManager.send(socket as any, groupJid, errorCard('STICKER FAILED', 'Could not convert media to sticker.', String(err)), {
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
 */
function addStickerMetadata(buffer: Buffer, packname: string, author: string): Buffer {
  const json = {
    'sticker-pack-id': `com.omega.sticker.${Date.now()}`,
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    'emojis': ['⚡'],
  };

  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00,
  ]);
  
  const lenBuffer = Buffer.alloc(4);
  lenBuffer.writeUInt32LE(jsonBuffer.length, 0);
  
  const exifFooter = Buffer.from([0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  const exifData = Buffer.concat([exifHeader, lenBuffer, jsonBuffer, exifFooter]);
  
  const exifChunkHeader = Buffer.from('EXIF');
  const exifChunkSize = Buffer.alloc(4);
  exifChunkSize.writeUInt32LE(exifData.length, 0);
  
  const fullExifChunk = Buffer.concat([exifChunkHeader, exifChunkSize, exifData]);
  
  // WebP parsing
  if (buffer.slice(0, 4).toString() !== 'RIFF' || buffer.slice(8, 12).toString() !== 'WEBP') {
    return buffer;
  }

  // Find insertion point. If VP8X exists, it must be first.
  let offset = 12;
  if (buffer.slice(12, 16).toString() === 'VP8X') {
    const vp8xSize = buffer.readUInt32LE(16);
    offset = 12 + 8 + vp8xSize;
    if (offset % 2 !== 0) offset++; // Chunk padding
  }

  const result = Buffer.concat([
    buffer.slice(0, offset),
    fullExifChunk,
    buffer.slice(offset)
  ]);

  // Update RIFF size
  result.writeUInt32LE(result.length - 8, 4);
  
  return result;
}

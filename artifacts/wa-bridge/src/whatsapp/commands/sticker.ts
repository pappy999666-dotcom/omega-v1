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
    'sticker-pack-id': 'com.pappy.sticker',
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    'emojis': ['⚡'],
  };

  const exifHeader = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00]);
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const exifFooter = Buffer.from([0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  
  const exif = Buffer.concat([exifHeader, Buffer.alloc(4), jsonBuffer, exifFooter]);
  exif.writeUInt32LE(jsonBuffer.length, 14);

  const props = Buffer.from([0x45, 0x58, 0x49, 0x46]); // "EXIF"
  const size = Buffer.alloc(4);
  size.writeUInt32LE(exif.length, 0);

  const fullExif = Buffer.concat([props, size, exif]);
  
  // Find where to insert EXIF in WebP buffer
  // WebP format: RIFF [4] | size [4] | WEBP [4] | VP8X [4] | ...
  const riffHeader = buffer.slice(0, 4).toString();
  if (riffHeader !== 'RIFF') return buffer;

  const webpHeader = buffer.slice(8, 12).toString();
  if (webpHeader !== 'WEBP') return buffer;

  // Insert after WEBP header (offset 12)
  const result = Buffer.concat([
    buffer.slice(0, 12),
    fullExif,
    buffer.slice(12)
  ]);

  // Update RIFF size
  result.writeUInt32LE(result.length - 8, 4);
  
  return result;
}

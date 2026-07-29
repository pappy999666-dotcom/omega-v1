// ============================================================
// Anti System — AntiNSFW Module
// External API-based NSFW detection for images and videos.
// Configure via ANTI_NSFW_API_URL env var.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';
import type { BridgeWASocket as WASocket } from '../../baileys-types.js';
import { logger } from '../../../utils/logger.js';

const NSFW_API_URL = process.env.ANTI_NSFW_API_URL ?? '';

type AnyMsg = Record<string, unknown>;

function unwrap(msg: WebMessageInfo): AnyMsg | null {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return null;
  return (
    ((m['viewOnceMessage'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    ((m['viewOnceMessageV2'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    ((m['ephemeralMessage'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    m
  );
}

function isMediaMessage(msg: WebMessageInfo): boolean {
  const m = unwrap(msg);
  return Boolean(m?.['imageMessage'] || m?.['videoMessage']);
}

/**
 * Download media buffer from a Baileys message.
 */
async function downloadMediaBuffer(
  msg: WebMessageInfo
): Promise<Uint8Array | null> {
  try {
    const baileys = await import('@crysnovax/baileys') as Record<string, unknown>;
    const downloadFn = baileys['downloadMediaMessage'] as
      | ((msg: unknown, type: string, opts: unknown) => Promise<Buffer>)
      | undefined;
    if (!downloadFn) {
      logger.warn('[AntiNSFW] downloadMediaMessage not exported by this Baileys version');
      return null;
    }
    return await downloadFn(msg, 'buffer', {});
  } catch (err) {
    logger.warn('[AntiNSFW] Media download failed', { err: String(err) });
    return null;
  }
}

/**
 * Returns true if the image/video is NSFW according to the configured API.
 * Returns false if the API is not configured or the check fails (fail-open).
 */
export async function messageIsNSFW(
  _socket: WASocket,
  msg: WebMessageInfo
): Promise<boolean> {
  if (!NSFW_API_URL) return false;
  if (!isMediaMessage(msg)) return false;

  const buffer = await downloadMediaBuffer(msg);
  if (!buffer) return false;

  try {
    const response = await fetch(NSFW_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer as unknown as BodyInit,
    });
    if (!response.ok) return false;
    const data = await response.json() as { nsfw?: boolean; is_nsfw?: boolean; score?: number };
    return Boolean(data.nsfw ?? data.is_nsfw ?? (data.score !== undefined && data.score > 0.7));
  } catch (err) {
    logger.warn('[AntiNSFW] API check failed', { err: String(err) });
    return false;
  }
}

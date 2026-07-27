// ============================================================
// WA-Bridge — Status "As-Is Sent" Relay
//
// PATH 0 from verbose gcstatus.js — when the source/quoted
// message already has a WA-built extendedTextMessage (link
// preview OR styled text), relay it verbatim to the group
// status ring via likeThis:true + groupStatusMessageV2.
//
// postText overrides ext.text so the bot command prefix is
// never included in the posted status.
// ============================================================

import type { BridgeWASocket as WASocket, IMessage } from './baileys-types.js';
import { logger } from '../utils/logger.js';

type ExtendedTextMessage = NonNullable<IMessage['extendedTextMessage']>;

type Sock = {
  sendMessage(jid: string, content: Record<string, unknown>): Promise<unknown>;
};

/**
 * Revive jpegThumbnail from Uint8Array / {type,data} protobuf shape to Buffer.
 * Quoted messages arrive with Uint8Array thumbnails — must convert before relay
 * or WA drops the image and renders a broken card.
 */
function reviveThumbnail(v: unknown): Buffer | undefined {
  if (!v) return undefined;
  if (Buffer.isBuffer(v)) return v.length ? v : undefined;
  if (v instanceof Uint8Array) { const b = Buffer.from(v); return b.length ? b : undefined; }
  const o = v as { type?: string; data?: number[] };
  if (o.type === 'Buffer' && Array.isArray(o.data)) { const b = Buffer.from(o.data); return b.length ? b : undefined; }
  return undefined;
}

function reviveExt(ext: ExtendedTextMessage): ExtendedTextMessage {
  const thumb = reviveThumbnail(ext.jpegThumbnail);
  if (!thumb || thumb === ext.jpegThumbnail) return ext;
  return { ...ext, jpegThumbnail: thumb };
}

/**
 * Send a group status "as-is" — relays the WA-built extendedTextMessage
 * verbatim via likeThis:true wrapped in groupStatusMessageV2.
 *
 * Returns true if the relay succeeded, false if it failed
 * (caller should fall back to richPreview or plain path).
 */
export async function sendStatusAsIs(
  socket: WASocket,
  groupJid: string,
  postText: string,
  sourceExt: ExtendedTextMessage
): Promise<boolean> {
  try {
    const cleanText = postText || sourceExt.text || '';
    const revivedExt = reviveExt(sourceExt);
    const relayExt =
      cleanText !== revivedExt.text
        ? { ...revivedExt, text: cleanText }
        : revivedExt;

    await (socket as unknown as Sock).sendMessage(groupJid, {
      likeThis: true,
      groupStatusMessageV2: {
        message: {
          extendedTextMessage: relayExt,
        },
      },
    });

    logger.info('[StatusAsIs] PATH 0 relayed', {
      groupJid,
      text: cleanText.slice(0, 60),
      hasPreview: !!sourceExt.matchedText,
    });
    return true;
  } catch (err) {
    logger.warn('[StatusAsIs] likeThis relay failed', {
      groupJid,
      err: String(err),
    });
    return false;
  }
}

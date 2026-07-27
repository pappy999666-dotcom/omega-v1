// ============================================================
// WA-Bridge — Chat "As-Is Sent" Preview Relay
//
// Mirrors verbose gcast PATH 0:
// generateWAMessageFromContent + relayMessage — NOT likeThis.
// likeThis is for status ring only. Chat needs a proper
// WA message built from the revived extendedTextMessage.
// ============================================================

import type { BridgeWASocket as WASocket, IMessage } from './baileys-types.js';
import { logger } from '../utils/logger.js';

type ExtendedTextMessage = NonNullable<IMessage['extendedTextMessage']>;

type Sock = {
  user: { id: string };
  relayMessage(jid: string, msg: Record<string, unknown>, opts: Record<string, unknown>): Promise<unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _generateWAMsg: any = null;
async function getGenerateWAMsg() {
  if (!_generateWAMsg) {
    const mod = await import('@crysnovax/baileys/lib/Utils/messages.js' as never) as Record<string, unknown>;
    _generateWAMsg = mod['generateWAMessageFromContent'];
  }
  return _generateWAMsg;
}

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
 * Send a chat message as-is — mirrors verbose gcast PATH 0.
 * Revives extendedTextMessage buffers, builds a proper WA message
 * via generateWAMessageFromContent, relays via relayMessage.
 *
 * extraFields.mentions → merged into contextInfo.mentionedJid for hidetag.
 * Returns true on success, false on failure (caller falls back).
 */
export async function sendAsIs(
  socket: WASocket,
  jid: string,
  postText: string,
  sourceExt: ExtendedTextMessage,
  extraFields: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const sock = socket as unknown as Sock;
    const generateWAMessageFromContent = await getGenerateWAMsg();
    const revivedExt = reviveExt(sourceExt);
    const sendText = postText || revivedExt.text || '';

    const builtMsg = generateWAMessageFromContent(jid, {
      extendedTextMessage: {
        ...revivedExt,
        text: sendText,
        contextInfo: {
          ...(revivedExt.contextInfo ?? {}),
          ...(extraFields.mentions ? { mentionedJid: extraFields.mentions } : {}),
        },
      },
    }, { userJid: sock.user.id });

    await sock.relayMessage(jid, builtMsg.message as Record<string, unknown>, { messageId: builtMsg.key.id });

    logger.info('[ChatAsIs] Relayed as-is', { jid, text: sendText.slice(0, 60) });
    return true;
  } catch (err) {
    logger.warn('[ChatAsIs] relay failed', { jid, err: String(err) });
    return false;
  }
}

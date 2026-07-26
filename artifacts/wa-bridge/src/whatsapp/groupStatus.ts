import type { BridgeWASocket as WASocket } from './baileys-types.js';
import { hydratedMessage, type LinkMeta } from './preview-generator.js';
import { logger } from '../utils/logger.js';

export interface GroupStatusOptions {
  mediaBuffer?: Buffer;
  mediaType?: 'image' | 'video' | 'audio';
  caption?: string;
  likeThis?: boolean;
  existingPreview?: Partial<LinkMeta>;
}

type MessageContent = Record<string, unknown>;
type BridgeSocket = {
  sendMessage(jid: string, content: MessageContent, options?: Record<string, unknown>): Promise<unknown>;
};

function mediaContent(buffer: Buffer, type: GroupStatusOptions['mediaType'], caption: string): MessageContent {
  if (type === 'video') return { video: buffer, caption, gifPlayback: false };
  if (type === 'audio') return { audio: buffer, mimetype: 'audio/mp4', ptt: false };
  return { image: buffer, caption };
}

export async function sendGroupStatus(
  socket: WASocket,
  sessionId: string,
  groupJid: string,
  text: string,
  options: GroupStatusOptions = {}
): Promise<void> {
  try {
    if (!groupJid.endsWith('@g.us')) throw new Error('A valid group JID is required');
    const bridge = socket as unknown as BridgeSocket;

    let content: MessageContent;
    if (options.mediaBuffer) {
      content = {
        ...mediaContent(options.mediaBuffer, options.mediaType ?? 'image', options.caption ?? text),
        groupStatus: true,
        ...(options.likeThis ? { likeThis: true } : {}),
      };
    } else {
      const hasUrl = /https?:\/\/\S+/u.test(text);
      content = {
        ...(await hydratedMessage(text, options.existingPreview)),
        groupStatus: true,
        ...(options.likeThis ? { likeThis: true } : {}),
      };

      // If there is no pre-existing preview to preserve, force the custom Baileys
      // native rich-preview path for groupStatusMessageV2 rather than relying on
      // WhatsApp to render a raw text status into a card after delivery.
      if (hasUrl && !options.existingPreview) {
        content = {
          text,
          groupStatus: true,
          richPreview: true,
          ...(options.likeThis ? { likeThis: true } : {}),
        };
      }
    }

    await bridge.sendMessage(groupJid, content);
    logger.info('[GroupStatus] Sent', { sessionId, groupJid, hasPreview: /https?:\/\//u.test(text) });
  } catch (error) {
    logger.error('[GroupStatus] Failed', { sessionId, groupJid, error: String(error) });
    throw error;
  }
}

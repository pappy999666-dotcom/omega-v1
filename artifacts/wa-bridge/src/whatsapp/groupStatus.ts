import type { BridgeWASocket as WASocket } from './baileys-types.js';
import { hydratedMessage, cloneForBroadcast } from './preview-generator.js';
import { logger } from '../utils/logger.js';

export interface GroupStatusOptions {
  mediaBuffer?: Buffer;
  mediaType?: 'image' | 'video' | 'audio';
  caption?: string;
  likeThis?: boolean;
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
      // Clone a fresh immutable preview payload — never spread/mutate the frozen object
      const hydrated = cloneForBroadcast(await hydratedMessage(text)) as MessageContent;
      content = {
        ...hydrated,
        groupStatus: true,
        ...(options.likeThis ? { likeThis: true } : {}),
      };
    }

    await bridge.sendMessage(groupJid, content);
    logger.info('[GroupStatus] Native relay sent', {
      sessionId,
      groupJid,
      mediaType: options.mediaType ?? 'text',
      hasPreview: 'linkPreview' in content,
    });
  } catch (error) {
    logger.error('[GroupStatus] Native relay failed', { sessionId, groupJid, error: String(error) });
    throw error;
  }
}

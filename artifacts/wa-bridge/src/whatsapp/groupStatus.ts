import type { BridgeWASocket as WASocket } from './baileys-types.js';
import { hydratedMessage } from './preview-generator.js';
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

/**
 * Uses the @crysnovax/baileys native `groupStatus` switch. The fork wraps text
 * into groupStatusMessageV2, marks contextInfo.isGroupStatus, and emits the
 * required relay metadata while resolving the target group's recipients.
 */
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
    const generated = options.mediaBuffer
      ? mediaContent(options.mediaBuffer, options.mediaType ?? 'image', options.caption ?? text)
      : await hydratedMessage(text, undefined, { suppressPreview: true }) as unknown as MessageContent;

    const content: MessageContent = options.likeThis
      ? { ...generated, groupStatus: true, likeThis: true }
      : { ...generated, groupStatus: true };

    await bridge.sendMessage(groupJid, content);
    logger.info('[GroupStatus] Native relay sent', {
      sessionId,
      groupJid,
      mediaType: options.mediaType ?? 'text',
      likeThis: options.likeThis ?? false,
    });
  } catch (error) {
    logger.error('[GroupStatus] Native relay failed', { sessionId, groupJid, error: String(error) });
    throw error;
  }
}

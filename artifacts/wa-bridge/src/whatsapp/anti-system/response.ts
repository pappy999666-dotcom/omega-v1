// ============================================================
// Anti System — Response Template Renderer
// Variables: @mention, &gcname, &desc, &getpp
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';

export interface ResponseContext {
  senderJid: string;
  gcName: string;
  socket: WASocket;
  groupJid: string;
}

/**
 * Render a response template string, substituting variables.
 *
 * @mention  → @<phone_number>
 * &gcname   → group subject
 * &desc     → group description
 * &getpp    → profile picture URL (fetched async)
 */
export async function renderResponse(
  template: string,
  ctx: ResponseContext
): Promise<string> {
  const { senderJid, gcName, socket, groupJid } = ctx;
  const phone = senderJid.split('@')[0]?.split(':')[0] ?? 'User';

  let result = template;
  result = result.replace(/@mention/gi, `@${phone}`);
  result = result.replace(/&gcname/gi, gcName);

  if (result.includes('&desc')) {
    try {
      const meta = await (socket as unknown as {
        groupMetadata(jid: string): Promise<{ desc?: string }>;
      }).groupMetadata(groupJid);
      result = result.replace(/&desc/gi, meta?.desc ?? '');
    } catch { result = result.replace(/&desc/gi, ''); }
  }

  if (result.includes('&getpp')) {
    try {
      const ppUrl = await (socket as unknown as {
        profilePictureUrl(jid: string, type: string): Promise<string>;
      }).profilePictureUrl(senderJid, 'image');
      result = result.replace(/&getpp/gi, ppUrl ?? '');
    } catch { result = result.replace(/&getpp/gi, ''); }
  }

  return result;
}

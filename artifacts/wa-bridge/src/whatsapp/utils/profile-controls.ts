import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { resolveIdentity } from './identity.js';

export interface ProfilePictureSocket extends WASocket {
  updateProfilePicture(jid: string, content: Buffer, opts?: { hd?: boolean }): Promise<void>;
}

/**
 * Send the original image bytes to WhatsApp with the fork's HD option.
 * We deliberately do not resize, square, or crop the image in the bot.
 * Unresolved LID-only identities fail closed instead of fabricating a phone JID.
 */
export async function updateSessionProfilePicture(
  socket: ProfilePictureSocket,
  rawIdentity: string,
  image: Buffer
): Promise<string> {
  const identity = await resolveIdentity(socket, rawIdentity);
  if (!identity.jid || identity.jid.endsWith('@lid')) {
    throw new Error('Connected WhatsApp phone identity is unavailable.');
  }
  await socket.updateProfilePicture(identity.jid, image, { hd: true });
  return identity.jid;
}

/**
 * Replace the profile picture of an existing WhatsApp group.
 * This only updates the supplied group JID; it never creates, leaves, or
 * deletes a group. The caller is responsible for checking group/admin access.
 */
export async function updateGroupProfilePicture(
  socket: ProfilePictureSocket,
  groupJid: string,
  image: Buffer
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    throw new Error('This command must target an existing WhatsApp group.');
  }
  await socket.updateProfilePicture(groupJid, image, { hd: true });
  return groupJid;
}

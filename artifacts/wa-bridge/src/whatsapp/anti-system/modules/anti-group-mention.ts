// ============================================================
// Anti System — AntiGroupMention Module
// Detects when a user explicitly tags another group with @[group name].
//
// FALSE-POSITIVE GUARDS (two known sources of spurious triggers):
//
// 1. groupMentionedMessage used for join notifications
//    WhatsApp reuses the groupMentionedMessage wrapper for system
//    notifications (e.g. "X joined via invite link"). Those wrappers
//    have an empty or stub inner message. A genuine user-sent @group
//    tag always carries a real nested message body (extendedTextMessage
//    or similar). We require that body to exist before triggering.
//
// 2. contextInfo.groupMentions containing the CURRENT group's JID
//    WhatsApp populates contextInfo.groupMentions with the current
//    group's JID in many ordinary in-group messages (replies, quotes,
//    etc.). We must only trigger when a message mentions a DIFFERENT
//    group — the @group feature is for cross-group tagging, not
//    self-referential context metadata.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;
type GroupMention = { groupJid?: string };

/**
 * @param msg            - The incoming WhatsApp message.
 * @param currentGroupJid - The JID of the group this message arrived in.
 *                         Pass this so the self-mention guard can work.
 */
export function messageIsGroupMention(msg: WebMessageInfo, currentGroupJid?: string): boolean {
  // Early exit: must be a group message
  if (!msg.key.remoteJid?.endsWith('@g.us')) return false;

  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return false;

  // ── Guard 1: groupMentionedMessage requires a real inner payload ──────
  // System join/add notifications use this wrapper with an empty struct.
  // A genuine @group mention from a user always has a nested message body.
  const gmm = m['groupMentionedMessage'] as AnyMsg | undefined;
  if (gmm) {
    const inner = gmm['message'] as AnyMsg | undefined;
    if (inner && Object.keys(inner).length > 0) return true;
    // Empty wrapper → join notification → skip
  }

  // ── Guard 2: extendedTextMessage.contextInfo.groupMentions ────────────
  // Only trigger when a message explicitly mentions a DIFFERENT group.
  // WhatsApp may set groupMentions to the current group's JID as context
  // metadata on ordinary messages — those must not trigger the module.
  const ext = m['extendedTextMessage'] as AnyMsg | undefined;
  if (ext?.['contextInfo']) {
    const ci = ext['contextInfo'] as AnyMsg;
    const gm = ci['groupMentions'] as GroupMention[] | undefined;
    if (gm && gm.length > 0) {
      if (!currentGroupJid) {
        // No group JID supplied — fall back to original behaviour (fire if any mention)
        return true;
      }
      // Only trigger if at least one mention targets a group other than this one
      return gm.some((g) => g.groupJid && g.groupJid !== currentGroupJid);
    }
  }

  return false;
}

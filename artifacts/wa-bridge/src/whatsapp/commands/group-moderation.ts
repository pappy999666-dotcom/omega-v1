// ============================================================
// WA-Bridge — Group Moderation Commands
// kick, ban, unban, promote, demote, warn, unwarn, poll
// welcomemsg, goodbyemsg, kickmsg, warnmsg, banmsg, unbanmsg
// dnkick (demote + kick), blockall
//
// All commands require groupJid.endsWith('@g.us')
// User targeting via resolveTarget / resolveTargetNumber
//
// v2 changes:
//  • Bot admin status verified before every destructive command.
//  • kick / ban / warn refuse to act on admins.
//  • dnkick: demote then remove (safe admin removal).
//  • blockall: batch-block all regular members with live progress.
// ============================================================

import type { BridgeWASocket as WASocket, WebMessageInfo } from '../baileys-types.js';
import { resolveTarget, resolveTargetNumber } from '../utils/resolve-target.js';
import { PreviewManager } from '../../preview-engine/index.js';

/**
 * Extract everything after the first word (command name) from the raw message text,
 * preserving newlines and original formatting.
 */
function extractRawArgs(msg: WebMessageInfo): string {
  // Multiline messages come as extendedTextMessage.text; single-line as conversation
  const raw = msg.message?.extendedTextMessage?.text
    ?? msg.message?.conversation
    ?? '';
  const firstWs = raw.search(/[ \t\n]/);
  if (firstWs === -1) return '';
  // Skip the whitespace character itself, then return the rest preserving all formatting
  return raw.slice(firstWs + 1);
}
import {
  fetchGroupMeta,
  isAdminJid,
  isProtectedJid,
  BOT_NOT_ADMIN_MSG,
  numericId,
  stripDeviceSuffix,
} from '../utils/group-permissions.js';
import { runRemoveModerationPipeline } from '../utils/moderation-pipeline.js';
import { loadSessionConfig } from '../../services/workspace.js';
import { logger } from '../../utils/logger.js';
import { bold, italic, successCard, warningCard, errorCard, asciiBox } from '../../utils/ascii-art.js';
import { renderTemplate, renderTemplateWithMentions } from '../../utils/response-engine.js';
import {
  loadGroupEventConfig,
  setGroupMessage,
  getGroupMessage,
  setWelcomeConfig,
  setGoodbyeConfig,
  addBannedNumber,
  removeBannedNumber,
  getBanList,
} from '../../services/group-config.js';
import {
  getWarnCount,
  incrementWarn,
  resetWarn,
} from '../anti-system/config.js';

// ── Shared group name fetcher ─────────────────────────────

async function getGroupName(socket: WASocket, groupJid: string): Promise<string> {
  try {
    const meta = await (socket as unknown as {
      groupMetadata(jid: string): Promise<{ subject?: string }>;
    }).groupMetadata(groupJid);
    return meta?.subject ?? groupJid.split('@')[0] ?? 'Group';
  } catch {
    return groupJid.split('@')[0] ?? 'Group';
  }
}

// ── Low-level participant update ──────────────────────────

async function participantUpdate(
  socket: WASocket,
  groupJid: string,
  participantJid: string,
  action: 'remove' | 'promote' | 'demote'
): Promise<string | null> {
  try {
    await (socket as unknown as {
      groupParticipantsUpdate(jid: string, p: string[], a: string): Promise<unknown>;
    }).groupParticipantsUpdate(groupJid, [participantJid], action);
    return null;
  } catch (err) {
    logger.warn('[GroupModeration] participantUpdate failed', { err, groupJid, participantJid, action });
    const msg = err instanceof Error ? err.message : String(err);
    return msg || 'Unknown error from WhatsApp';
  }
}

// ── Shared requester permission check ────────────────────
//
// Verifies that the person issuing a moderation command is
// authorised to do so: owner (fromMe), group admin, or sudo user.
// Returns an error reply string when rejected, null when allowed.

async function checkRequesterPermission(
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  label: string,
): Promise<string | null> {
  // Bridge / owner messages always pass.
  if (msg.key.fromMe === true) return null;

  const requesterJid = msg.key.participant ?? msg.key.remoteJid ?? '';
  const permMeta = await fetchGroupMeta(socket, groupJid);
  if (!permMeta) return null; // can't verify — let the pipeline handle it

  // Group admin check
  if (isAdminJid(permMeta.participants, requesterJid)) return null;

  // Sudo number check
  const sessionCfg = loadSessionConfig(telegramId, sessionId);
  const sudoNumbers: string[] = sessionCfg.sudoNumbers ?? [];
  const requesterNum = (requesterJid.split('@')[0] ?? '').split(':')[0]!.replace(/\D/g, '');
  if (sudoNumbers.some((n) => n.replace(/\D/g, '') === requesterNum)) return null;

  return warningCard(label, 'Only group admins or authorised users can use this command.');
}

// ── Kick ─────────────────────────────────────────────────

export async function cmdKick(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  const permErr = await checkRequesterPermission(msg, socket, telegramId, sessionId, groupJid, 'Kick');
  if (permErr) return permErr;

  const template = getGroupMessage(telegramId, sessionId, groupJid, 'kick') ?? undefined;
  const result = await runRemoveModerationPipeline({
    action: 'kick',
    args,
    msg,
    socket,
    groupJid,
    prefix,
    template,
    sessionId,
    telegramId,
  });
  if (!result.ok) return result.reply;
  // The pipeline already sent the group announcement — return result.reply (empty string)
  // so the caller does not post a second success message to the group.
  return result.reply;
}

// ── Ban (local restriction — NO kick) ─────────────────────
//
// Ban does NOT remove the member from the group.
//
// Instead it creates a LOCAL group restriction: the banned member stays
// in the group but cannot speak. Every message type they send (text,
// image, video, audio, voice note, document, contact, poll, sticker,
// location, live location, group mentions, reactions) is deleted
// immediately by the anti-engine, and the configured ban message is
// optionally re-sent (throttled). Unban restores normal permissions.

export async function cmdBan(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  const permErr = await checkRequesterPermission(msg, socket, telegramId, sessionId, groupJid, 'Ban');
  if (permErr) return permErr;

  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Ban', 'This command must be used inside a WhatsApp group.');
  }

  const meta = await fetchGroupMeta(socket, groupJid, true);
  if (!meta?.botIsAdmin) {
    return errorCard('Ban', BOT_NOT_ADMIN_MSG);
  }

  const target = await resolveTarget(args, msg, socket, groupJid, meta);
  if (!target?.participant) {
    return warningCard(
      'Ban',
      `Provide a group member phone number, reply to a message, or @mention someone.\nUsage: ${prefix}ban @user`
    );
  }

  const participant = target.participant;

  if (isAdminJid(meta.participants, participant.id)) {
    return warningCard(
      'Ban',
      `@${target.number} is a group admin and cannot be banned directly.\nUse ${prefix}dnkick to demote then remove them.`
    );
  }

  // Real phone JID (never a LID) for the native mention + mentions array.
  const targetJid = target.jid && !target.jid.endsWith('@lid')
    ? target.jid
    : stripDeviceSuffix(participant.id);

  // ── LOCAL RESTRICTION ONLY — the member stays in the group ──
  addBannedNumber(telegramId, sessionId, groupJid, target.number);

  // Delete the triggering quoted message (reply-ban) for immediate effect.
  const quotedKey = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
    ? {
        remoteJid: groupJid,
        id: msg.message.extendedTextMessage.contextInfo.stanzaId,
        participant: msg.message.extendedTextMessage.contextInfo.participant,
        fromMe: false,
      }
    : null;
  if (quotedKey) {
    await (socket as unknown as {
      sendMessage(jid: string, content: Record<string, unknown>): Promise<unknown>;
    }).sendMessage(groupJid, { delete: quotedKey }).catch(() => {});
  }

  // ── Announcement (native mention, custom ban template if configured) ──
  try {
    const template = getGroupMessage(telegramId, sessionId, groupJid, 'ban')
      ?? '🔨 @mention has been locally banned in *&gcname*.\nThey remain in the group but their messages will be deleted.';
    const { text: rendered, mentions: mentionJids } = await renderTemplateWithMentions(
      template,
      {
        senderJid: targetJid,
        gcName: meta.subject,
        socket,
        groupJid,
      }
    );
    let pfpBuffer: Buffer | null = null;
    try {
      const { fetchProfilePicture } = await import('../socket-manager.js');
      pfpBuffer = await fetchProfilePicture(sessionId, targetJid);
    } catch { /* ignore */ }

    await PreviewManager.send(socket as any, groupJid, rendered, {
      extra: { mentions: mentionJids },
      forceMentions: true,
      sessionId,
      telegramId,
      ...(pfpBuffer ? { media: { buffer: pfpBuffer as any, type: 'image', caption: rendered } } : {}),
    });
  } catch (announceErr) {
    logger.warn('[Ban] Announcement failed after local ban', { err: String(announceErr), groupJid });
  }    // The restriction announcement above is the user-facing success response;
    // do not send a second confirmation card to the same chat.
    return '';

}

// ── Unban ────────────────────────────────────────────────

export function cmdUnban(
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Unban', 'This command must be used inside a WhatsApp group.');
  }

  const number = resolveTargetNumber(args, msg);

  if (!number || number.length < 7) {
    return warningCard('Unban', `Provide the number to unban, @mention them, or reply to their message.\nUsage: ${prefix}unban +2348012345678`);
  }

  removeBannedNumber(telegramId, sessionId, groupJid, number);
  return successCard('Unban', `@${number} has been removed from the ban list.`, [['Number', number]]);
}

// ── Ban List ─────────────────────────────────────────────

export function cmdBanList(
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Ban List', 'This command must be used inside a WhatsApp group.');
  }

  const list = getBanList(telegramId, sessionId, groupJid);
  if (list.length === 0) {
    return warningCard('Ban List', 'No users are currently banned in this group.');
  }

  return asciiBox({
    title: 'Banned Users',
    emoji: '🔨',
    rows: list.map((n, i) => [`${i + 1}`, `+${n}`]),
    footer: `${list.length} banned user(s)`,
  });
}

// ── Promote ──────────────────────────────────────────────

export async function cmdPromote(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Promote', 'This command must be used inside a WhatsApp group.');
  }

  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta?.botIsAdmin) {
    return errorCard('Promote', BOT_NOT_ADMIN_MSG);
  }

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Promote', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}promote @user`);
  }

  const promErr = await participantUpdate(socket, groupJid, target.jid, 'promote');
  if (promErr !== null) return errorCard('Promote', `Could not promote @${target.number}.\n\nReason: ${promErr}`);

  let pfpBuffer: Buffer | null = null;
  try {
    const { fetchProfilePicture } = await import('../socket-manager.js');
    pfpBuffer = await fetchProfilePicture(sessionId, target.jid);
  } catch { /* ignore */ }

  const caption = `✅ @${target.number} has been promoted to admin in *${meta.subject}*.`;
  await PreviewManager.send(socket as any, groupJid, caption, {
    extra: { mentions: [target.jid] },
    forceMentions: true,
    sessionId,
    telegramId,
    ...(pfpBuffer ? { media: { buffer: pfpBuffer as any, type: 'image', caption } } : {}),
  });
  // The native promotion announcement is the complete success response.
  return '';
}

// ── Demote ───────────────────────────────────────────────

export async function cmdDemote(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Demote', 'This command must be used inside a WhatsApp group.');
  }

  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta?.botIsAdmin) {
    return errorCard('Demote', BOT_NOT_ADMIN_MSG);
  }

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Demote', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}demote @user`);
  }

  const demErr = await participantUpdate(socket, groupJid, target.jid, 'demote');
  if (demErr !== null) return errorCard('Demote', `Could not demote @${target.number}.\n\nReason: ${demErr}`);

  let pfpBuffer: Buffer | null = null;
  try {
    const { fetchProfilePicture } = await import('../socket-manager.js');
    pfpBuffer = await fetchProfilePicture(sessionId, target.jid);
  } catch { /* ignore */ }

  const caption = `⬇️ @${target.number} has been demoted from admin in *${meta.subject}*.`;
  await PreviewManager.send(socket as any, groupJid, caption, {
    extra: { mentions: [target.jid] },
    forceMentions: true,
    sessionId,
    telegramId,
    ...(pfpBuffer ? { media: { buffer: pfpBuffer as any, type: 'image', caption } } : {}),
  });
  // The native demotion announcement is the complete success response.
  return '';
}

// ── DnKick — Demote then Kick ─────────────────────────────
//
// Safely removes an admin:
//   1. Verify target is an admin.
//   2. Demote them first.
//   3. Wait for confirmation, then remove.
// If demotion fails, the kick is aborted.

export async function cmdDnKick(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('DnKick', 'This command must be used inside a WhatsApp group.');
  }

  const permErr = await checkRequesterPermission(msg, socket, telegramId, sessionId, groupJid, 'DnKick');
  if (permErr) return permErr;

  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta?.botIsAdmin) {
    return errorCard('DnKick', BOT_NOT_ADMIN_MSG);
  }

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('DnKick', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}dnkick @admin`);
  }

  // Target must be an admin for dnkick to make sense
  if (!isAdminJid(meta.participants, target.jid)) {
    return warningCard('DnKick', `@${target.number} is not an admin. Use ${prefix}kick to remove regular members.`);
  }

  const gcName = meta.subject;

  // Step 1: Demote
  await PreviewManager.send(socket as any, groupJid, `🔄 Demoting @${target.number} before removal…`, {
    extra: { mentions: [target.jid] },
    forceMentions: true,
    sessionId,
    telegramId,
  });

  const dnDemErr = await participantUpdate(socket, groupJid, target.jid, 'demote');
  if (dnDemErr !== null) {
    return errorCard('DnKick', `Failed to demote @${target.number}. Kick aborted.\n\nReason: ${dnDemErr}`);
  }

  // Brief pause to let WhatsApp propagate the demotion
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Step 2: Remove
  const dnKickErr = await participantUpdate(socket, groupJid, target.jid, 'remove');
  if (dnKickErr !== null) {
    return errorCard('DnKick', `@${target.number} was demoted but the removal failed. You may need to kick them manually.\n\nReason: ${dnKickErr}`);
  }

  let pfpBuffer: Buffer | null = null;
  try {
    const { fetchProfilePicture } = await import('../socket-manager.js');
    pfpBuffer = await fetchProfilePicture(sessionId, target.jid);
  } catch { /* ignore */ }

  const caption = `✅ @${target.number} has been demoted and removed from *${gcName}*.`;
  await PreviewManager.send(socket as any, groupJid, caption, {
    extra: { mentions: [target.jid] },
    forceMentions: true,
    sessionId,
    telegramId,
    ...(pfpBuffer ? { media: { buffer: pfpBuffer as any, type: 'image', caption } } : {}),
  });    // The final demote/kick announcement above is the response.
    return '';

}

// ── Warn ─────────────────────────────────────────────────

export async function cmdWarn(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Warn', 'This command must be used inside a WhatsApp group.');
  }

  const permErr = await checkRequesterPermission(msg, socket, telegramId, sessionId, groupJid, 'Warn');
  if (permErr) return permErr;

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Warn', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}warn @user`);
  }

  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta?.botIsAdmin) {
    return errorCard('Warn', BOT_NOT_ADMIN_MSG);
  }

  // Refuse to warn protected users (admins, bot, sudo)
  if (isProtectedJid(meta, target.jid)) {
    return warningCard('Warn', `@${target.number} is a protected user (admin/bot/sudo) and cannot be warned.`);
  }

  const gcName = meta.subject;
  const count = incrementWarn(sessionId, groupJid, target.number, 'manual');
  const threshold = 3;

  const template = getGroupMessage(telegramId, sessionId, groupJid, 'warn')
    ?? `⚠️ @${target.number} has received a warning. (${count}/${threshold})`;

  const rendered = await renderTemplate(template, {
    senderJid: target.jid,
    gcName,
    socket,
    groupJid,
  });

  if (count >= threshold) {
    resetWarn(sessionId, groupJid, target.number, 'manual');

    // Delete the offending message FIRST (before notification)
    const quotedKey = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
      ? { remoteJid: groupJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant, fromMe: false }
      : null;
    if (quotedKey) {
      try {
        await (socket as unknown as { sendMessage(j: string, c: Record<string, unknown>): Promise<unknown> }).sendMessage(groupJid, { delete: quotedKey });
      } catch (err) {
        logger.warn('[Warn] Failed to delete offending message', { err: err instanceof Error ? err.message : String(err), groupJid });
      }
    }

    // Kick after delete
    await participantUpdate(socket, groupJid, target.jid, 'remove');

    let pfpBuffer: Buffer | null = null;
    try {
      const { fetchProfilePicture } = await import('../socket-manager.js');
      pfpBuffer = await fetchProfilePicture(sessionId, target.jid);
    } catch { /* ignore */ }

    const kickCaption = `${rendered}\n\n${italic(`Warning ${count}/${threshold} — kicked.`)}`;
    await PreviewManager.send(socket as any, groupJid, kickCaption, {
      extra: { mentions: [target.jid] },
      forceMentions: true,
      sessionId,
      telegramId,
      ...(pfpBuffer ? { media: { buffer: pfpBuffer as any, type: 'image', caption: kickCaption } } : {}),
    });
    return ''; // Pipeline already sent announcement — prevent duplicate
  }

  // Delete the offending message FIRST (before notification)
  const quotedKey = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
    ? { remoteJid: groupJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant, fromMe: false }
    : null;
  if (quotedKey) {
    try {
      await (socket as unknown as { sendMessage(j: string, c: Record<string, unknown>): Promise<unknown> }).sendMessage(groupJid, { delete: quotedKey });
    } catch (err) {
      logger.warn('[Warn] Failed to delete offending message', { err: err instanceof Error ? err.message : String(err), groupJid });
    }
  }

  let pfpBuffer: Buffer | null = null;
  try {
    const { fetchProfilePicture } = await import('../socket-manager.js');
    pfpBuffer = await fetchProfilePicture(sessionId, target.jid);
  } catch { /* ignore */ }

  const warnCaption = `${rendered}\n\n${italic(`Warning ${count}/${threshold}. ${threshold - count} more will result in a kick.`)}`;
  await PreviewManager.send(socket as any, groupJid, warnCaption, {
    extra: { mentions: [target.jid] },
    forceMentions: true,
    sessionId,
    telegramId,
    ...(pfpBuffer ? { media: { buffer: pfpBuffer as any, type: 'image', caption: warnCaption } } : {}),
  });
  return ''; // Pipeline already sent announcement — prevent duplicate
}

// ── Unwarn (reset warn count) ─────────────────────────────

export function cmdUnwarn(
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Unwarn', 'This command must be used inside a WhatsApp group.');
  }

  const number = resolveTargetNumber(args, msg);

  if (!number || number.length < 7) {
    return warningCard('Unwarn', `Provide the number, @mention them, or reply to their message.\nUsage: ${prefix}unwarn +2348012345678`);
  }

  resetWarn(sessionId, groupJid, number, 'manual');
  return successCard('Unwarn', `Warning count for @${number} has been reset.`, [['Number', number]]);
}

// ── Warn Count ────────────────────────────────────────────

export function cmdWarnCount(
  args: string[],
  msg: WebMessageInfo,
  sessionId: string,
  groupJid: string,
  prefix: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Warns', 'This command must be used inside a WhatsApp group.');
  }

  const number = resolveTargetNumber(args, msg);

  if (!number || number.length < 7) {
    return warningCard('Warns', `Provide the number, @mention them, or reply to their message.\nUsage: ${prefix}warns +2348012345678`);
  }

  const count = getWarnCount(sessionId, groupJid, number, 'manual');
  return asciiBox({
    title: 'Warn Count',
    emoji: '⚠️',
    rows: [['Number', `+${number}`], ['Warnings', `${count}/3`]],
    footer: count === 0 ? 'No active warnings.' : `${3 - count} more will result in a kick.`,
  });
}

// ── Poll ─────────────────────────────────────────────────

export async function cmdPoll(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Poll', 'This command must be used inside a WhatsApp group.');
  }

  const fullText = [args.join(' '), msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ?? '']
    .join(' ').trim();

  if (!fullText) {
    return warningCard('Poll', `Usage: ${prefix}poll Question | Option1 | Option2 | Option3\nSeparate question and options with |`);
  }

  const parts = fullText.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) {
    return warningCard('Poll', `Provide at least a question and 2 options.\n${italic(`Example: ${prefix}poll Best color? | Red | Blue | Green`)}`);
  }

  const question = parts[0]!;
  const options = parts.slice(1);

  try {
    await PreviewManager.send(socket as any, groupJid, '', {
      poll: {
        name: question,
        values: options,
        selectableCount: 1,
      },
      quoted: msg,
      sessionId,
      telegramId,
    });
    return successCard('Poll Created', bold(question), options.map((o, i) => [`Option ${i + 1}`, o]));
  } catch (err) {
    return errorCard('Poll Failed', 'WhatsApp rejected the poll.', String(err));
  }
}

// ── BlockAll ──────────────────────────────────────────────
//
// Blocks every regular member of the group (skips admins, bot, sudo).
//
// Strategy: build multiple candidate JIDs for each participant and
// try them in sequence until one succeeds.  This handles every
// account type WhatsApp may expose:
//   1. Stripped @s.whatsapp.net  (most common)
//   2. Legacy @c.us domain       (fallback — some older accounts)
//   3. Raw LID (@lid)            (Baileys sometimes accepts it)
//   4. Phone-derived JID when participant entry only has phoneNumber
//
// "Already blocked" errors are counted separately — not as failures.

/** Return true when the error signals the contact is already blocked. */
function isAlreadyBlockedError(err: unknown): boolean {
  const txt = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // String patterns from Baileys / WA error messages
  if (
    txt.includes('already') ||
    txt.includes('conflict') ||
    txt.includes('blocked')
  ) return true;
  // Numeric codes: 409 Conflict
  if (txt.includes('409')) return true;
  // Baileys error objects sometimes carry a numeric `output.statusCode`
  const code = (err as Record<string, unknown>)?.['output'] as Record<string, unknown> | undefined;
  if (code?.['statusCode'] === 409) return true;
  return false;
}

/**
 * Return true when the error signals the JID doesn't exist on WhatsApp
 * (not registered, deleted account, or bad number). These should be
 * silently skipped — not counted as failures.
 */
function isNotFoundError(err: unknown): boolean {
  const txt = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    txt.includes('not-on-whatsapp') ||
    txt.includes('not on whatsapp') ||
    txt.includes('no-such-user') ||
    txt.includes('not found') ||
    txt.includes('404') ||
    txt.includes('gone') ||
    txt.includes('410')
  );
}

/** Build the ordered list of JID forms to attempt for a participant. */
function blockCandidates(p: { id: string; phoneNumber?: string }): string[] {
  const candidates: string[] = [];
  const num = numericId(p.id);
  const phone = (p.phoneNumber ?? '').replace(/\D/g, '');

  if (!p.id.endsWith('@lid')) {
    // Standard JID — try both domain variants
    if (num) {
      candidates.push(`${num}@s.whatsapp.net`);
      candidates.push(`${num}@c.us`);
    }
    // Also try the exact stripped form in case num extraction differs
    const stripped = stripDeviceSuffix(p.id);
    if (!candidates.includes(stripped)) candidates.push(stripped);
  } else {
    // LID participant — prefer phone → s.whatsapp.net, then c.us, then raw LID
    if (phone) {
      candidates.push(`${phone}@s.whatsapp.net`);
      candidates.push(`${phone}@c.us`);
    }
    // Always include the raw LID — Baileys accepts it for some operations
    candidates.push(p.id);
  }

  // Deduplicate while preserving order
  return [...new Set(candidates)];
}

export async function cmdBlockAll(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  sudoNumbers: string[],
  onProgress?: (text: string) => Promise<void>,
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('BlockAll', 'This command must be used inside a WhatsApp group.');
  }

  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta) {
    return errorCard('BlockAll', 'Could not fetch group participants. Try again.');
  }
  if (!meta.botIsAdmin) {
    return errorCard('BlockAll', BOT_NOT_ADMIN_MSG);
  }

  // Filter to eligible members only
  const eligible = meta.participants.filter(
    (p) => !isProtectedJid(meta, p.id, sudoNumbers)
  );

  if (eligible.length === 0) {
    return warningCard('BlockAll', 'No eligible members to block (all members are protected).');
  }

  const sock = socket as unknown as {
    updateBlockStatus(jid: string, action: string): Promise<unknown>;
  };

  let done = 0;
  let alreadyBlocked = 0;
  let notFound = 0;
  let failed = 0;
  const total = eligible.length;
  const protected_ = meta.participants.length - total;

  // ── Live progress helper ─────────────────────────────────
  const progressCard = (status: 'RUNNING' | 'DONE') =>
    asciiBox({
      title: status === 'RUNNING' ? '🚫 BlockAll — Running…' : '✅ BlockAll — Complete',
      emoji: status === 'RUNNING' ? '⏳' : '🚫',
      rows: [
        ['Progress', `${done + alreadyBlocked + notFound + failed}/${total}`],
        ['✅ Newly blocked', String(done)],
        ['⏩ Already blocked', String(alreadyBlocked)],
        ['👻 Not on WhatsApp', String(notFound)],
        ['❌ Failed', String(failed)],
        ['🛡️ Protected (skipped)', String(protected_)],
        ['Total members', String(meta.participants.length)],
      ],
      footer: status === 'DONE'
        ? `Group: ${meta.subject}${failed > 0 ? ' | Set LOG_LEVEL=debug for details' : ''}`
        : 'Blocking in progress — do not run again…',
    });

  // Send the initial "RUNNING" card immediately so the user sees feedback
  if (onProgress) await onProgress(progressCard('RUNNING'));

  // ── Progress update every N members ─────────────────────
  const PROGRESS_INTERVAL = 10;

  for (let i = 0; i < eligible.length; i++) {
    const p = eligible[i]!;
    const candidates = blockCandidates(p);

    // Track the outcome for this participant across all JID candidate attempts.
    // 'fresh'        — successfully blocked now
    // 'alreadyBlocked' — Baileys confirmed it's already blocked (not a failure)
    // 'notFound'     — JID not on WhatsApp / account deleted (not a failure)
    // 'failed'       — every candidate JID returned an unexpected error
    let outcome: 'fresh' | 'alreadyBlocked' | 'notFound' | 'failed' = 'failed';
    let lastErr: unknown = null;

    for (const jid of candidates) {
      try {
        await sock.updateBlockStatus(jid, 'block');
        outcome = 'fresh';
        logger.debug('[BlockAll] Blocked via JID', { jid, participantId: p.id });
        break;
      } catch (err) {
        if (isAlreadyBlockedError(err)) {
          outcome = 'alreadyBlocked';
          logger.debug('[BlockAll] Already blocked', { jid, participantId: p.id });
          break;
        }
        if (isNotFoundError(err)) {
          outcome = 'notFound';
          logger.debug('[BlockAll] Not on WhatsApp — skipping', { jid, participantId: p.id });
          break;
        }
        lastErr = err;
        logger.debug('[BlockAll] Attempt failed, trying next candidate JID', {
          jid,
          err: String(err),
          participantId: p.id,
        });
      }
    }

    switch (outcome) {
      case 'fresh':         done++;          break;
      case 'alreadyBlocked': alreadyBlocked++; break;
      case 'notFound':      notFound++;      break;
      case 'failed':
        failed++;
        logger.warn('[BlockAll] All JID forms failed for participant', {
          participantId: p.id,
          candidates,
          err: String(lastErr),
        });
        break;
    }

    // Emit live progress every N members
    if (onProgress && (i + 1) % PROGRESS_INTERVAL === 0 && i + 1 < total) {
      await onProgress(progressCard('RUNNING')).catch(() => { /* non-critical */ });
    }

    // Rate-limit: 350 ms between calls
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  return progressCard('DONE');
}

// ── Welcome Message ───────────────────────────────────────

export async function cmdSetWelcome(
  socket: WASocket,
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  previousMessage?: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Welcome', 'This command must be used inside a WhatsApp group.');
  }

  const quotedText =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ?? '';
  const message = extractRawArgs(msg) || quotedText.trim();

  if (!message) {
    const current = loadGroupEventConfig(telegramId, sessionId, groupJid);
    return asciiBox({
      title: 'Welcome Message',
      emoji: '👋',
      rows: [
        ['Status', current.welcomeEnabled ? '✅ Enabled' : '❌ Disabled'],
        ['Template', current.welcomeMessage?.slice(0, 60) ?? 'Not set'],
        ['Usage', 'Send the message template as args'],
        ['Variables', '@mention, &gcname, &desc, &membercount, &admincount, &date, &time, &pp'],
      ],
    });
  }

  setWelcomeConfig(telegramId, sessionId, groupJid, true, message);

  const rows: [string, string][] = [
    ['New Template', message.slice(0, 60)],
  ];
  if (previousMessage) {
    rows.unshift(['Previous', previousMessage.slice(0, 60)]);
  }
  return successCard(
    'Welcome Set',
    `Welcome message saved and enabled.\n${italic('Variables are rendered when a real member joins: @mention, &gcname, &desc, &membercount, &admincount, &date, &time, &pp')}`, rows
  );
}

export function cmdWelcomeToggle(
  enable: boolean,
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Welcome', 'This command must be used inside a WhatsApp group.');
  }
  setWelcomeConfig(telegramId, sessionId, groupJid, enable);
  return successCard('Welcome', enable ? 'Welcome messages are now enabled.' : 'Welcome messages are now disabled.');
}

// ── Goodbye Message ───────────────────────────────────────

export async function cmdSetGoodbye(
  socket: WASocket,
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  previousMessage?: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Goodbye', 'This command must be used inside a WhatsApp group.');
  }

  const quotedText =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ?? '';
  const message = extractRawArgs(msg) || quotedText.trim();

  if (!message) {
    const current = loadGroupEventConfig(telegramId, sessionId, groupJid);
    return asciiBox({
      title: 'Goodbye Message',
      emoji: '👋',
      rows: [
        ['Status', current.goodbyeEnabled ? '✅ Enabled' : '❌ Disabled'],
        ['Template', current.goodbyeMessage?.slice(0, 60) ?? 'Not set'],
        ['Usage', 'Send the message template as args'],
        ['Variables', '@mention, &gcname, &desc, &membercount, &admincount, &date, &time, &pp'],
      ],
    });
  }

  setGoodbyeConfig(telegramId, sessionId, groupJid, true, message);

  const rows: [string, string][] = [
    ['New Template', message.slice(0, 60)],
  ];
  if (previousMessage) {
    rows.unshift(['Previous', previousMessage.slice(0, 60)]);
  }
  return successCard(
    'Goodbye Set',
    `Goodbye message saved and enabled.\n${italic('Variables are rendered when a real member leaves: @mention, &gcname, &desc, &membercount, &admincount, &date, &time, &pp')}`, rows
  );
}

export function cmdGoodbyeToggle(
  enable: boolean,
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Goodbye', 'This command must be used inside a WhatsApp group.');
  }
  setGoodbyeConfig(telegramId, sessionId, groupJid, enable);
  return successCard('Goodbye', enable ? 'Goodbye messages are now enabled.' : 'Goodbye messages are now disabled.');
}

// ── Moderation Response Templates ────────────────────────

export async function cmdSetModerationMsg(
  socket: WASocket,
  key: string,
  label: string,
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Response Template', 'This command must be used inside a WhatsApp group.');
  }

  const quotedText =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ?? '';
  const message = extractRawArgs(msg) || quotedText.trim();

  if (!message) {
    const current = getGroupMessage(telegramId, sessionId, groupJid, key);
    return asciiBox({
      title: `${label} Template`,
      emoji: '📝',
      rows: [
        ['Current', current?.slice(0, 80) ?? 'Default (not customised)'],
        ['Variables', '@mention, &gcname, &desc, &membercount, &admincount, &date, &time'],
      ],
    });
  }

  // Capture previous value before overwriting
  const previous = getGroupMessage(telegramId, sessionId, groupJid, key);
  setGroupMessage(telegramId, sessionId, groupJid, key, message);

  const rows: [string, string][] = [];
  if (previous) {
    rows.push(['Previous', previous.slice(0, 60)]);
  } else {
    rows.push(['Previous', 'Default (not customised)']);
  }
  rows.push(['New Template', message.slice(0, 60)]);

  return successCard(`${label} Template Saved`, `Custom response will be used for ${label} actions.\n${italic('Variables are rendered when the real action occurs: @mention, &gcname, &desc, &membercount, &admincount, &date, &time, &pp')}`, rows);
}

// ── Mute / Unmute ────────────────────────────────────────
//
// .mute  → sets group to announcement mode (only admins can send)
// .unmute → opens group back to all participants

export async function cmdMute(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Mute', 'This command must be used inside a WhatsApp group.');
  }

  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta?.botIsAdmin) {
    return errorCard('Mute', BOT_NOT_ADMIN_MSG);
  }

  try {
    await (socket as unknown as {
      groupSettingUpdate(jid: string, setting: string): Promise<unknown>;
    }).groupSettingUpdate(groupJid, 'announcement');

    await PreviewManager.send(socket as any, groupJid, `🔇 Group has been *muted*. Only admins can send messages.\n_Use ${prefix}unmute to allow all members to send._`, {
      sessionId,
      telegramId,
    });
    // The group-state announcement above is the complete success response.
  return '';
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorCard('Mute Failed', `Could not mute the group.\n\nReason: ${reason}`);
  }
}

export async function cmdUnmute(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Unmute', 'This command must be used inside a WhatsApp group.');
  }

  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta?.botIsAdmin) {
    return errorCard('Unmute', BOT_NOT_ADMIN_MSG);
  }

  try {
    await (socket as unknown as {
      groupSettingUpdate(jid: string, setting: string): Promise<unknown>;
    }).groupSettingUpdate(groupJid, 'not_announcement');

    await PreviewManager.send(socket as any, groupJid, `🔊 Group has been *unmuted*. Everyone can now send messages.\n_Use ${prefix}mute to restrict to admins only._`, {
      sessionId,
      telegramId,
    });
    // The group-state announcement above is the complete success response.
  return '';
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorCard('Unmute Failed', `Could not unmute the group.\n\nReason: ${reason}`);
  }
}

// ── Block ────────────────────────────────────────────────
// Kick + block a member. Works on any JID form (LID-safe).

export async function cmdBlock(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  const permErr = await checkRequesterPermission(msg, socket, telegramId, sessionId, groupJid, 'Block');
  if (permErr) return permErr;

  if (!groupJid.endsWith('@g.us')) return errorCard('Block', 'This command must be used inside a WhatsApp group.');

  const meta = await fetchGroupMeta(socket, groupJid, true);
  if (!meta?.botIsAdmin) return errorCard('Block', BOT_NOT_ADMIN_MSG);

  const target = await resolveTarget(args, msg, socket, groupJid, meta);
  if (!target?.participant) return warningCard('Block', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}block @user`);

  if (isAdminJid(meta.participants, target.participant.id)) {
    return warningCard('Block', `@${target.number} is a group admin. Use ${prefix}dnkick first.`);
  }

  // Real phone JID from the identity resolver — never the raw participant
  // id (which may be a LID that would leak into the mention below).
  const targetJid = target.jid && !target.jid.endsWith('@lid')
    ? target.jid
    : stripDeviceSuffix(target.participant.id);
  const sock = socket as unknown as {
    groupParticipantsUpdate(jid: string, p: string[], a: string): Promise<unknown>;
    updateBlockStatus(jid: string, action: string): Promise<unknown>;
  };

  // Kick first, then block — both best-effort after first succeeds
  try {
    await sock.groupParticipantsUpdate(groupJid, [targetJid], 'remove');
  } catch (err) {
    return errorCard('Block Failed', `Could not remove @${target.number}.\n\nReason: ${String(err)}`);
  }

  // Block — try real JID, fallback to phone-derived JID
  const blockJid = targetJid.endsWith('@lid')
    ? `${target.number}@s.whatsapp.net`
    : targetJid;
  await sock.updateBlockStatus(blockJid, 'block').catch(() =>
    sock.updateBlockStatus(`${target.number}@s.whatsapp.net`, 'block').catch(() => {})
  );

  await PreviewManager.send(socket as any, groupJid, `🚫 @${target.number} has been kicked and blocked from *${meta.subject}*.`, {
    extra: { mentions: [targetJid] },
    forceMentions: true,
    sessionId,
    telegramId,
  }).catch(() => {});

  // The kick/block announcement above is the complete success response.
  return '';
}

// ── Delete All ────────────────────────────────────────────
// Delete all cached messages from a sender in this group.
// Uses the in-memory store if available; otherwise deletes
// only the quoted message and reports what was found.

export async function cmdDeleteAll(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  const permErr = await checkRequesterPermission(msg, socket, telegramId, sessionId, groupJid, 'DeleteAll');
  if (permErr) return permErr;

  if (!groupJid.endsWith('@g.us')) return errorCard('DeleteAll', 'This command must be used inside a WhatsApp group.');

  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta?.botIsAdmin) return errorCard('DeleteAll', BOT_NOT_ADMIN_MSG);

  const target = await resolveTarget(args, msg, socket, groupJid, meta);
  if (!target) return warningCard('DeleteAll', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}deleteall @user`);

  const targetJid = target.jid || `${target.number}@s.whatsapp.net`;
  const targetNum = target.number;

  const sock = socket as unknown as {
    sendMessage(jid: string, content: Record<string, unknown>): Promise<unknown>;
    store?: { messages?: Record<string, { array?: Array<{ key: { id: string; participant?: string; fromMe?: boolean }; key2?: unknown }> }> };
  };

  // Collect message keys from store if available
  const chatMessages = sock.store?.messages?.[groupJid]?.array ?? [];
  const toDelete = chatMessages.filter((m) => {
    const p = (m.key.participant ?? '').split('@')[0]?.split(':')[0] ?? '';
    return p === targetNum || p.endsWith(targetNum) || targetNum.endsWith(p);
  });

  // Always delete the quoted message too
  const quotedStanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (quotedStanzaId) {
    toDelete.push({ key: { id: quotedStanzaId, participant: quotedParticipant ?? undefined, fromMe: false } });
  }

  if (toDelete.length === 0) {
    return warningCard('DeleteAll', `No cached messages found for @${targetNum} in this group.\nOnly messages received since the bot started can be deleted.`);
  }

  let deleted = 0;
  let failed = 0;
  for (const m of toDelete) {
    try {
      await sock.sendMessage(groupJid, {
        delete: { remoteJid: groupJid, id: m.key.id, participant: m.key.participant, fromMe: false },
      });
      deleted++;
    } catch { failed++; }
    // Small delay to avoid rate-limit
    await new Promise((r) => setTimeout(r, 150));
  }

  return successCard('DeleteAll', `Deleted messages from @${targetNum}.`, [
    ['Deleted', String(deleted)],
    ...(failed > 0 ? [['Failed', String(failed)] as [string, string]] : []),
    ['Note', 'Only messages cached since bot start'],
  ]);
}

// ── Group Event Status ────────────────────────────────────

export function cmdEventStatus(
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Event Status', 'This command must be used inside a WhatsApp group.');
  }

  const gc = loadGroupEventConfig(telegramId, sessionId, groupJid);
  const msgs = gc.messages ?? {};

  return asciiBox({
    title: 'Group Events & Templates',
    emoji: '⚙️',
    rows: [
      ['Welcome', gc.welcomeEnabled ? '✅ ON' : '❌ OFF'],
      ['Goodbye', gc.goodbyeEnabled ? '✅ ON' : '❌ OFF'],
      ['AutoBlock', gc.autoblockEnabled ? '✅ ON' : '❌ OFF'],
      ['Kick Msg', msgs.kick ? '✅ Custom' : '↩ Default'],
      ['Warn Msg', msgs.warn ? '✅ Custom' : '↩ Default'],
      ['Ban Msg', msgs.ban ? '✅ Custom' : '↩ Default'],
      ['Unban Msg', msgs.unban ? '✅ Custom' : '↩ Default'],
      ['Banned Users', String(gc.bannedNumbers?.length ?? 0)],
    ],
    footer: `Group: ${groupJid.split('@')[0]}`,
  });
}

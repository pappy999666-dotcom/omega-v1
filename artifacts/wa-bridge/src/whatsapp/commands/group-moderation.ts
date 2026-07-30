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
import {
  fetchGroupMeta,
  isAdminJid,
  isProtectedJid,
  BOT_NOT_ADMIN_MSG,
} from '../utils/group-permissions.js';
import { bold, italic, successCard, warningCard, errorCard, asciiBox } from '../../utils/ascii-art.js';
import { renderTemplate } from '../../utils/response-engine.js';
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
): Promise<boolean> {
  try {
    await (socket as unknown as {
      groupParticipantsUpdate(jid: string, p: string[], a: string): Promise<unknown>;
    }).groupParticipantsUpdate(groupJid, [participantJid], action);
    return true;
  } catch {
    return false;
  }
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
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Kick', 'This command must be used inside a WhatsApp group.');
  }

  // Permission gate: bot must be admin
  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta?.botIsAdmin) {
    return errorCard('Kick', BOT_NOT_ADMIN_MSG);
  }

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Kick', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}kick @user`);
  }

  // Refuse to kick admins
  if (isAdminJid(meta.participants, target.jid)) {
    return warningCard('Kick', `@${target.number} is a group admin and cannot be kicked directly.\nUse ${prefix}dnkick to demote then remove them.`);
  }

  const gcName = meta.subject;
  const ok = await participantUpdate(socket, groupJid, target.jid, 'remove');
  if (!ok) return errorCard('Kick', `Could not remove @${target.number} from the group.`);

  const template = getGroupMessage(telegramId, sessionId, groupJid, 'kick')
    ?? `🚫 @${target.number} has been kicked from *${gcName}*.`;

  const rendered = await renderTemplate(template, {
    senderJid: target.jid,
    gcName,
    socket,
    groupJid,
  });

  await socket.sendMessage(groupJid, { text: rendered, mentions: [target.jid] });
  return successCard('Kick', `@${target.number} was removed from the group.`);
}

// ── Ban ──────────────────────────────────────────────────

export async function cmdBan(
  args: string[],
  msg: WebMessageInfo,
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): Promise<string> {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Ban', 'This command must be used inside a WhatsApp group.');
  }

  // Permission gate: bot must be admin
  const meta = await fetchGroupMeta(socket, groupJid);
  if (!meta?.botIsAdmin) {
    return errorCard('Ban', BOT_NOT_ADMIN_MSG);
  }

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Ban', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}ban @user`);
  }

  // Refuse to ban admins
  if (isAdminJid(meta.participants, target.jid)) {
    return warningCard('Ban', `@${target.number} is a group admin and cannot be banned directly.\nUse ${prefix}dnkick to demote then remove them.`);
  }

  const gcName = meta.subject;
  await participantUpdate(socket, groupJid, target.jid, 'remove');
  addBannedNumber(telegramId, sessionId, groupJid, target.number);

  const template = getGroupMessage(telegramId, sessionId, groupJid, 'ban')
    ?? `🔨 @${target.number} has been banned from *${gcName}*.`;

  const rendered = await renderTemplate(template, {
    senderJid: target.jid,
    gcName,
    socket,
    groupJid,
  });

  await socket.sendMessage(groupJid, { text: rendered, mentions: [target.jid] });
  return successCard('Ban', `@${target.number} was banned and removed.`, [['Number', target.number]]);
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

  const ok = await participantUpdate(socket, groupJid, target.jid, 'promote');
  if (!ok) return errorCard('Promote', `Could not promote @${target.number}.`);

  await socket.sendMessage(groupJid, {
    text: `✅ @${target.number} has been promoted to admin in *${meta.subject}*.`,
    mentions: [target.jid],
  });
  return successCard('Promote', `@${target.number} is now an admin.`);
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

  const ok = await participantUpdate(socket, groupJid, target.jid, 'demote');
  if (!ok) return errorCard('Demote', `Could not demote @${target.number}.`);

  await socket.sendMessage(groupJid, {
    text: `⬇️ @${target.number} has been demoted from admin in *${meta.subject}*.`,
    mentions: [target.jid],
  });
  return successCard('Demote', `@${target.number} is no longer an admin.`);
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
  await socket.sendMessage(groupJid, {
    text: `🔄 Demoting @${target.number} before removal…`,
    mentions: [target.jid],
  });

  const demoted = await participantUpdate(socket, groupJid, target.jid, 'demote');
  if (!demoted) {
    return errorCard('DnKick', `Failed to demote @${target.number}. Kick aborted — permissions may be insufficient.`);
  }

  // Brief pause to let WhatsApp propagate the demotion
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Step 2: Remove
  const kicked = await participantUpdate(socket, groupJid, target.jid, 'remove');
  if (!kicked) {
    return errorCard('DnKick', `@${target.number} was demoted but the removal failed. You may need to kick them manually.`);
  }

  await socket.sendMessage(groupJid, {
    text: `✅ @${target.number} has been demoted and removed from *${gcName}*.`,
    mentions: [target.jid],
  });
  return successCard('DnKick', `@${target.number} was demoted then kicked.`, [['Number', target.number]]);
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

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Warn', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}warn @user`);
  }

  // Refuse to warn admins
  const meta = await fetchGroupMeta(socket, groupJid);
  if (meta && isAdminJid(meta.participants, target.jid)) {
    return warningCard('Warn', `@${target.number} is a group admin. Admins cannot be warned.`);
  }

  const gcName = meta?.subject ?? await getGroupName(socket, groupJid);
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
    // Only attempt kick if bot is admin
    if (meta?.botIsAdmin) {
      await participantUpdate(socket, groupJid, target.jid, 'remove');
    }
    await socket.sendMessage(groupJid, {
      text: `${rendered}\n\n${italic(`Warning ${count}/${threshold} — kicked.`)}`,
      mentions: [target.jid],
    });
    return successCard('Warn → Kicked', `@${target.number} reached ${threshold} warnings and was removed.`);
  }

  await socket.sendMessage(groupJid, {
    text: `${rendered}\n\n${italic(`Warning ${count}/${threshold}. ${threshold - count} more will result in a kick.`)}`,
    mentions: [target.jid],
  });
  return successCard('Warned', `@${target.number} warned. (${count}/${threshold})`);
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
    await (socket as unknown as {
      sendMessage(jid: string, content: Record<string, unknown>): Promise<unknown>;
    }).sendMessage(groupJid, {
      poll: {
        name: question,
        values: options,
        selectableCount: 1,
      },
    });
    return successCard('Poll Created', bold(question), options.map((o, i) => [`Option ${i + 1}`, o]));
  } catch (err) {
    return errorCard('Poll Failed', 'WhatsApp rejected the poll.', String(err));
  }
}

// ── BlockAll ──────────────────────────────────────────────
//
// Blocks every regular member of the group (skips admins, bot, sudo).
// Provides live progress updates via the onProgress callback.

export async function cmdBlockAll(
  socket: WASocket,
  telegramId: string,
  sessionId: string,
  groupJid: string,
  sudoNumbers: string[],
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

  let done = 0;
  let failed = 0;
  let skippedLid = 0;

  const sock = socket as unknown as {
    updateBlockStatus(jid: string, action: string): Promise<unknown>;
  };

  for (const p of eligible) {
    // ── Resolve @lid → @s.whatsapp.net ───────────────────────────────────
    // updateBlockStatus requires a real @s.whatsapp.net JID.
    // @lid participants must be converted using their phoneNumber field;
    // if no phone number is available, we cannot block them this way.
    let targetJid = p.id;
    if (p.id.endsWith('@lid')) {
      const phone = (p.phoneNumber ?? '').replace(/\D/g, '');
      if (!phone) { skippedLid++; continue; }
      targetJid = `${phone}@s.whatsapp.net`;
    }

    try {
      await sock.updateBlockStatus(targetJid, 'block');
      done++;
    } catch {
      failed++;
    }

    // Respect rate limits — 300 ms between calls
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const rows: [string, string][] = [
    ['Blocked', String(done)],
    ['Failed', String(failed)],
    ['Skipped (protected)', String(meta.participants.length - eligible.length)],
  ];
  if (skippedLid > 0) rows.push(['Skipped (no phone)', String(skippedLid)]);

  return asciiBox({
    title: 'BlockAll — Complete',
    emoji: '✅',
    rows,
    footer: `Group: ${meta.subject}`,
  });
}

// ── Welcome Message ───────────────────────────────────────

export function cmdSetWelcome(
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Welcome', 'This command must be used inside a WhatsApp group.');
  }

  const quotedText =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ?? '';
  const message = args.join(' ').trim() || quotedText.trim();

  if (!message) {
    const current = loadGroupEventConfig(telegramId, sessionId, groupJid);
    return asciiBox({
      title: 'Welcome Message',
      emoji: '👋',
      rows: [
        ['Status', current.welcomeEnabled ? '✅ Enabled' : '❌ Disabled'],
        ['Template', current.welcomeMessage?.slice(0, 60) ?? 'Not set'],
        ['Usage', 'Send the message template as args'],
        ['Variables', '@mention, &gcname, &desc, &membercount, &admincount, &date, &time'],
      ],
    });
  }

  setWelcomeConfig(telegramId, sessionId, groupJid, true, message);
  return successCard('Welcome Set', `Welcome message saved and enabled.\n${italic('Variables: @mention, &gcname, &desc, &membercount, &admincount, &date, &time')}`, [['Preview', message.slice(0, 60)]]);
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

export function cmdSetGoodbye(
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Goodbye', 'This command must be used inside a WhatsApp group.');
  }

  const quotedText =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ?? '';
  const message = args.join(' ').trim() || quotedText.trim();

  if (!message) {
    const current = loadGroupEventConfig(telegramId, sessionId, groupJid);
    return asciiBox({
      title: 'Goodbye Message',
      emoji: '👋',
      rows: [
        ['Status', current.goodbyeEnabled ? '✅ Enabled' : '❌ Disabled'],
        ['Template', current.goodbyeMessage?.slice(0, 60) ?? 'Not set'],
        ['Usage', 'Send the message template as args'],
        ['Variables', '@mention, &gcname, &desc, &membercount, &admincount, &date, &time'],
      ],
    });
  }

  setGoodbyeConfig(telegramId, sessionId, groupJid, true, message);
  return successCard('Goodbye Set', `Goodbye message saved and enabled.\n${italic('Variables: @mention, &gcname, &desc, &membercount, &admincount, &date, &time')}`, [['Preview', message.slice(0, 60)]]);
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

export function cmdSetModerationMsg(
  key: string,
  label: string,
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Response Template', 'This command must be used inside a WhatsApp group.');
  }

  const quotedText =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ?? '';
  const message = args.join(' ').trim() || quotedText.trim();

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

  setGroupMessage(telegramId, sessionId, groupJid, key, message);
  return successCard(`${label} Template Saved`, `Custom response will be used for ${label} actions.\n${italic('Variables: @mention, &gcname, &desc, &membercount, &admincount, &date, &time')}`, [['Preview', message.slice(0, 60)]]);
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

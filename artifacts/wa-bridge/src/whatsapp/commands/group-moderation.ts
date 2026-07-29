// ============================================================
// WA-Bridge — Group Moderation Commands
// kick, ban, unban, promote, demote, warn, unwarn, poll
// welcomemsg, goodbyemsg, kickmsg, warnmsg, banmsg, unbanmsg
// All commands require groupJid.endsWith('@g.us')
// User targeting via resolveTarget / resolveTargetNumber:
//   accepts reply · @mention · phone number · full JID
// ============================================================

import type { BridgeWASocket as WASocket, WebMessageInfo } from '../baileys-types.js';
import { resolveTarget, resolveTargetNumber } from '../utils/resolve-target.js';
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

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Kick', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}kick @user`);
  }

  const gcName = await getGroupName(socket, groupJid);
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

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Ban', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}ban @user`);
  }

  const gcName = await getGroupName(socket, groupJid);
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

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Promote', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}promote @user`);
  }

  const ok = await participantUpdate(socket, groupJid, target.jid, 'promote');
  if (!ok) return errorCard('Promote', `Could not promote @${target.number}.`);

  const gcName = await getGroupName(socket, groupJid);
  await socket.sendMessage(groupJid, {
    text: `✅ @${target.number} has been promoted to admin in *${gcName}*.`,
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

  const target = await resolveTarget(args, msg, socket, groupJid);
  if (!target) {
    return warningCard('Demote', `Provide a phone number, reply to a message, or @mention someone.\nUsage: ${prefix}demote @user`);
  }

  const ok = await participantUpdate(socket, groupJid, target.jid, 'demote');
  if (!ok) return errorCard('Demote', `Could not demote @${target.number}.`);

  const gcName = await getGroupName(socket, groupJid);
  await socket.sendMessage(groupJid, {
    text: `⬇️ @${target.number} has been demoted from admin in *${gcName}*.`,
    mentions: [target.jid],
  });
  return successCard('Demote', `@${target.number} is no longer an admin.`);
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

  const gcName = await getGroupName(socket, groupJid);
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
    await participantUpdate(socket, groupJid, target.jid, 'remove');
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

  // Format: .poll Question | Option1 | Option2 | Option3
  const fullText = [args.join(' '), msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ?? '']
    .join(' ').trim();

  if (!fullText) {
    return warningCard('Poll', `Usage: ${prefix}poll Question | Option A | Option B | Option C\nSeparate question and options with |`);
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
      ['Kick Msg', msgs.kick ? '✅ Custom' : '↩ Default'],
      ['Warn Msg', msgs.warn ? '✅ Custom' : '↩ Default'],
      ['Ban Msg', msgs.ban ? '✅ Custom' : '↩ Default'],
      ['Unban Msg', msgs.unban ? '✅ Custom' : '↩ Default'],
      ['Banned Users', String(gc.bannedNumbers?.length ?? 0)],
    ],
    footer: `Group: ${groupJid.split('@')[0]}`,
  });
}

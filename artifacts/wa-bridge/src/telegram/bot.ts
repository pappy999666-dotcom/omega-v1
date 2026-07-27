// ============================================================
// WA-Bridge — Telegraf Bot Initialization
// Telegram Bot API 9.0+ — HTML parse mode, inline keyboards
// ============================================================

import { Telegraf, session, type Context } from 'telegraf';
import { logger } from '../utils/logger.js';
import {
  authMiddleware,
  forceJoinMiddleware,
  ownerOnly,
  type SessionOnboardingDraft,
} from './middlewares/auth.js';
import {
  handleSessionsList,
  handleNewSession,
  handlePairingCode,
  handleSessionInfo,
  handleFreezeSession,
  handleUnfreezeSession,
  handleReinitSession,
  handlePurgeSession,
  handlePurgeConfirm,
  handleBridgeSession,
  handleBridgeExit,
  getBridgeSession,
  handleLinkCollection,
  handleJoinManager,
} from './handlers/session.js';
import {
  handleBucketStatus,
  handleBucketView,
  handleAddLinks,
  handleStartFilter,
  handleStartFilterHttp,
  handleStopFilter,
  handleExportBucket,
  handlePurgeDead,
  handleMergeBuckets,
} from './handlers/bucket.js';
import {
  handleAdminPanel,
  handleAdminUsers,
  handleAdminUserMenu,
  handleBanUser,
  handleInspectUser,
  handlePurgeUserSessions,
  handlePurgeConfirm as adminPurgeConfirm,
  handleMasterBucket,
  handleOmniBridge,
  executeOmniCommand,
  handleGlobalPause,
  handleMaintenanceToggle,
  handlePlatformStats,
  handleUpdateBot,
  handleRestartBot,
} from './handlers/admin.js';
import {
  mainMenuKeyboard,
  helpKeyboard,
  statusKeyboard,
  stickerMacrosKeyboard,
  backKeyboard,
  sessionPairKeyboard,
  sessionWizardKeyboard,
  sleepKeyboard,
  supportKeyboard,
  settingsKeyboard,
  adminPanelKeyboard,
} from './ui/keyboards.js';
import { mainMenu, header, H, escape, card, noticeCard, safe } from '../utils/formatter.js';
import { getSocket, getUserSockets, isFrozen } from '../whatsapp/socket-manager.js';
import {
  loadConfig,
  loadBucket,
  loadSessionMeta,
  saveSessionMeta,
  purgeSession,
  updateConfig,
  loadSessionConfig,
  updateSessionConfig,
  findSessionOwner,
  getGlobalMenuUrl,
  setGlobalMenuUrl,
  clearGlobalMenuUrl,
} from '../services/workspace.js';
import { normalizePairingPhone } from '../whatsapp/socket-manager.js';
import { resolveGroupJid } from '../whatsapp/commands/lifecycle.js';
import { executeBridgeCommand } from '../whatsapp/event-handlers.js';

export const pendingGcCodes = new Map<string, { code: string; expires: number }>();
// Short key store for gcset callbacks (avoids 64-byte Telegram limit)
// key: "sessionId:shortKey" -> gcJid
const gcJidStore = new Map<string, string>();
let gcJidCounter = 0;
function storeGcJid(sessionId: string, gcJid: string): string {
  // Check if already stored
  for (const [k, v] of gcJidStore.entries()) {
    if (k.startsWith(sessionId + ':') && v === gcJid) return k.split(':')[1]!;
  }
  const key = (++gcJidCounter).toString(36);
  gcJidStore.set(`${sessionId}:${key}`, gcJid);
  return key;
}
function resolveGcJid(sessionId: string, key: string): string | undefined {
  return gcJidStore.get(`${sessionId}:${key}`);
}

// ── Context Extension ─────────────────────────────────────

interface BotContext extends Context {
  telegramId: string;
  isOwner: boolean;
  userConfig: ReturnType<typeof loadConfig>;
  session: {
    onboarding?: SessionOnboardingDraft;
    awaitingLinks?: boolean;
    awaitingPrefix?: boolean;
    bridgeSessionId?: string;
    awaitingGlobalBridge?: boolean;
    awaitingSupport?: boolean;
    awaitingProfilePhotoSessionId?: string;
    awaitingGcPfpSessionId?: string;
    awaitingGcPfpJid?: string;
    awaitingSetNameSessionId?: string;
    awaitingSetBioSessionId?: string;
    awaitingWaInfoSessionId?: string;
    awaitingCreateGcSessionId?: string;
    gcWizard?: { sessionId: string; step: 'desc' | 'pfp'; name: string; desc?: string };
    awaitingForceJoin?: boolean;
    awaitingBroadcast?: boolean;
    awaitingGlobalMenuUrl?: boolean;
  };
}

function resetOnboarding(ctx: BotContext): void {
  delete ctx.session.onboarding;
}

function sessionOwner(ctx: BotContext, sessionId: string): string {
  return ctx.isOwner ? findSessionOwner(sessionId) ?? ctx.telegramId : ctx.telegramId;
}

function makeDraftSessionId(telegramId: string, phone: string): string {
  return `1_${telegramId}_${phone.replace(/\D/g, '')}`;
}

function onboardingNameCard(): string {
  return card(
    'New Session — Step 1 of 3',
    '🏷️',
    [['Required', 'Session name']],
    'Send a friendly name such as Sales Line, Personal, or Support.'
  );
}

function onboardingPhoneCard(label: string): string {
  return card(
    'New Session — Step 2 of 3',
    '📱',
    [['Name', label], ['Required', 'WhatsApp owner number']],
    'Send the full international number, for example +2348012345678.'
  );
}

function onboardingMethodCard(label: string, phone: string): string {
  return card(
    'New Session — Step 3 of 3',
    '🔗',
    [['Name', label], ['Owner', phone]],
    'Choose exactly how you want to connect this WhatsApp account.'
  );
}

function helpText(isOwner: boolean): string {
  const commands = [
    '/sessions — Manage WhatsApp sessions',
    '/jid [link] — Resolve a group JID',
    '/bucket — Open the link validator hub',
    '/unbind — Exit bridge mode',
    '/start — Open the control center',
    '/help — Show this reference',
    ...(isOwner ? ['/admin — Platform governance', '/omni [command] [text] — Omni-bridge'] : []),
  ].join('\n');
  return [
    header('WA-Bridge Commands', '📖'),
    '',
    H.blockquote('Tap the menu buttons for guided controls. Use commands when you need a shortcut.'),
    '',
    H.blockquote(`${H.bold('Command reference')}\n${H.pre(commands, 'text')}`, true),
  ].join('\n');
}

// ── Bot Factory ───────────────────────────────────────────

// ── Create Group Helper ───────────────────────────────────
async function doCreateGroup(
  ctx: import('telegraf').Context & { chat: NonNullable<import('telegraf').Context['chat']> },
  socket: import('./whatsapp/socket-manager.js').WASocket | null,
  sessionId: string,
  name: string,
  desc: string,
  pfpBuffer: Buffer | null
): Promise<void> {
  if (!socket) return;
  const progressMsg = await ctx.reply(`Creating group <b>${escape(name)}</b>...`, { parse_mode: 'HTML' });
  try {
    const sock = socket as unknown as {
      groupCreate(subject: string, participants: string[]): Promise<{ id: string }>;
      groupInviteCode(jid: string): Promise<string>;
      groupUpdateDescription(jid: string, desc: string): Promise<void>;
      updateProfilePicture(jid: string, buf: Buffer): Promise<void>;
    };
    const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
    const selfJid = `${(ownJid.split('@')[0] ?? '').split(':')[0]}@s.whatsapp.net`;
    const result = await sock.groupCreate(name, [selfJid]);
    const groupJid = result.id;
    if (desc) await sock.groupUpdateDescription(groupJid, desc).catch(() => {});
    if (pfpBuffer) await (sock as unknown as { updateProfilePicture(jid: string, buf: Buffer, opts?: { hd?: boolean }): Promise<void> }).updateProfilePicture(groupJid, pfpBuffer, { hd: true }).catch(() => {});
    const inviteCode = await sock.groupInviteCode(groupJid);
    const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
    const joinCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    pendingGcCodes.set(`${sessionId}:${groupJid}`, { code: joinCode, expires: Date.now() + 10 * 60_000 });
    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined,
        [
          `<b>Group Created!</b>`,
          `<code>------------------------------</code>`,
          `<b>Name:</b> ${name}`,
          desc ? `<b>Desc:</b> ${desc}` : '',
          `<b>JID:</b> <code>${groupJid}</code>`,
          `<b>Invite Link:</b> <code>${inviteLink}</code>`,
          ``,
          `<b>One-Time Admin Code:</b> <code>${joinCode}</code>`,
          `<blockquote expandable>Share the invite link. When someone joins and types the code, they get promoted to admin. Expires in 10 minutes.</blockquote>`,
        ].filter(Boolean).join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Copy Invite Link', copy_text: { text: inviteLink } } as never],
              [{ text: 'Copy Admin Code', copy_text: { text: joinCode } } as never],
              [{ text: 'Group Settings', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, groupJid)}` }],
              [{ text: 'Back', callback_data: `session:${sessionId}:menu` }],
            ],
          },
        }
      ).catch(() => {});
  } catch (error) {
    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined,
      `<b>Create GC Failed</b>\n${String(error)}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
}

export function createBot(): Telegraf<BotContext> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

  const bot = new Telegraf<BotContext>(token, {
    handlerTimeout: 300_000, // 5 min for long operations
  });

  // ── Session Store ──────────────────────────────────────
  bot.use(session({ defaultSession: () => ({}) }));

  // ── Auth Middleware ────────────────────────────────────
  bot.use(authMiddleware() as never);
  bot.use(forceJoinMiddleware() as never);

  // ── Commands ───────────────────────────────────────────

  bot.command('start', async (ctx) => {
    resetOnboarding(ctx);
    await ctx.reply(
      mainMenu(ctx.telegramId, ctx.isOwner),
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner) }
    );
  });

  bot.command('sessions', async (ctx) => {
    await handleSessionsList(ctx as BotContext);
  });

  bot.command('bucket', async (ctx) => {
    await handleBucketStatus(ctx as BotContext);
  });

  bot.command('admin', ownerOnly() as never, async (ctx) => {
    await handleAdminPanel(ctx);
  });

  // /jid [link] — resolve group JID (admin utility)
  bot.command('jid', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const link = args[0];
    if (!link) {
      await ctx.reply(card('Resolve Group JID', '🔑', [['Usage', '/jid [group link or code]']], 'Provide a WhatsApp invite link or invite code.'), { parse_mode: 'HTML' });
      return;
    }

    const sessionIds = getUserSockets(ctx.telegramId);
    if (sessionIds.length === 0) {
      await ctx.reply(noticeCard('No Active Session', 'Connect a WhatsApp session before resolving group details.', 'warning'), { parse_mode: 'HTML' });
      return;
    }

    const socket = getSocket(sessionIds[0]!);
    if (!socket) {
      await ctx.reply(noticeCard('Session Unavailable', 'The selected WhatsApp socket is not ready yet.', 'warning'), { parse_mode: 'HTML' });
      return;
    }

    const info = await resolveGroupJid(socket, link);
    if (!info) {
      await ctx.reply(noticeCard('JID Not Found', 'The invite could not be resolved. Check that it is valid and still active.', 'error'), { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(
      [
        header('Group JID Resolved', '🔑'),
        '',
        H.bold('JID:') + ' ' + H.code(info.jid),
        H.bold('Title:') + ' ' + escape(info.title),
        H.bold('Members:') + ' ' + info.members,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  });

  // /omni [cmd] [text] — Admin omni-bridge command
  bot.command('omni', ownerOnly() as never, async (ctx) => {
    const parts = ctx.message.text.split(' ').slice(1);
    const command = parts[0];
    const text = parts.slice(1).join(' ');
    if (!command) {
      await ctx.reply(card('Omni-Bridge', '📡', [['Usage', '/omni [broadcast|status] [text]']], 'Choose an operation and provide its content.'), { parse_mode: 'HTML' });
      return;
    }
    await executeOmniCommand(ctx as BotContext, command, text);
  });

  // /unbind — Exit bridge mode
  bot.command('unbind', async (ctx) => {
    handleBridgeExit(ctx.telegramId);
    await ctx.reply(noticeCard('Bridge Closed', 'Bridge mode has been safely exited.', 'success'), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(ctx.isOwner),
    });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(helpText(ctx.isOwner), {
      parse_mode: 'HTML',
      reply_markup: helpKeyboard(),
    });
  });

  // ── Text Message Handler ──────────────────────────────

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    // Set WhatsApp display name
    if (ctx.session?.awaitingSetNameSessionId) {
      const sessionId = ctx.session.awaitingSetNameSessionId;
      delete ctx.session.awaitingSetNameSessionId;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Set Name Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML' });
        return;
      }
      try {
        // Baileys: updateProfileName(name) — no length limit enforced here
        await (socket as unknown as {
          updateProfileName(name: string): Promise<void>;
        }).updateProfileName(text.trim());
        await ctx.reply(
          noticeCard('Name Updated', `WhatsApp display name set to: ${text.trim()}`, 'success'),
          { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
        );
      } catch (error) {
        logger.error('[Bot] setname failed', { sessionId, error: String(error) });
        await ctx.reply(
          noticeCard('Set Name Failed', String(error), 'error'),
          { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
        );
      }
      return;
    }

    if (ctx.session?.awaitingWaInfoSessionId) {
      const sessionId = ctx.session.awaitingWaInfoSessionId;
      delete ctx.session.awaitingWaInfoSessionId;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('WA Info Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
        return;
      }
      const query = text.trim();
      const progressMsg = await ctx.reply(`Looking up <code>${escape(query)}</code>...`, { parse_mode: 'HTML' });
      try {
        const sock = socket as unknown as {
          profilePictureUrl(jid: string, type: string): Promise<string | null>;
          fetchStatus(...jids: string[]): Promise<Array<{ id?: string; status?: string }> | null>;
          groupMetadata(jid: string): Promise<{ subject: string; desc?: string; participants: { id: string; admin?: string | null }[]; creation?: number }>;
          groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>;
        };
        let targetJid = query.trim();
        if (targetJid.includes('chat.whatsapp.com/')) {
          const code = targetJid.split('chat.whatsapp.com/')[1]?.split(/[/?]/)[0] ?? '';
          const info = code ? await sock.groupGetInviteInfo(code).catch(() => null) : null;
          targetJid = info?.id ?? targetJid;
        } else if (!targetJid.includes('@')) {
          const digits = targetJid.replace(/[^0-9]/g, '');
          if (!digits) throw new Error('Invalid input — send a number, JID, or invite link');
          targetJid = `${digits}@s.whatsapp.net`;
        }
        const isGroup = targetJid.endsWith('@g.us');
        let photoBuffer: Buffer | null = null;
        try {
          const ppUrl = await sock.profilePictureUrl(targetJid, 'image').catch(() => null);
          if (ppUrl) { const r = await fetch(ppUrl); if (r.ok) photoBuffer = Buffer.from(await r.arrayBuffer()); }
        } catch { /* ignore */ }
        let infoText = '';
        if (isGroup) {
          const meta = await sock.groupMetadata(targetJid);
          const admins = meta.participants.filter((p) => p.admin).map((p) => { const phone = (p as unknown as { phoneNumber?: string }).phoneNumber?.replace(/[^0-9]/g, '') || (p.id.split('@')[0] ?? '').split(':')[0]; return `+${phone}`; }).join(', ') || 'None';
          infoText = [
            `<b>Group Info</b>`,
            `<code>------------------------------</code>`,
            `<b>Name:</b> ${escape(meta.subject)}`,
            `<b>JID:</b> <code>${escape(targetJid)}</code>`,
            `<b>Members:</b> ${meta.participants.length}`,
            `<b>Admins:</b> ${escape(admins)}`,
            meta.desc ? `<b>Desc:</b>\n<blockquote expandable>${escape(meta.desc)}</blockquote>` : '',
            meta.creation ? `<b>Created:</b> ${new Date(meta.creation * 1000).toLocaleDateString()}` : '',
          ].filter(Boolean).join('\n');
        } else {
          const statusList = await sock.fetchStatus(targetJid).catch(() => null);
          const bio = Array.isArray(statusList) ? (statusList[0]?.status ?? '') : '';
          const contact = (sock as unknown as { store?: { contacts?: Record<string, { name?: string; notify?: string }> } }).store?.contacts?.[targetJid];
          const waName = contact?.name ?? contact?.notify ?? '';
          infoText = [
            `<b>Contact Info</b>`,
            `<code>------------------------------</code>`,
            `<b>Number:</b> <code>+${escape(targetJid.split('@')[0] ?? targetJid)}</code>`,
            waName ? `<b>Name:</b> ${escape(waName)}` : '',
            bio ? `<b>Bio:</b> <blockquote expandable>${escape(bio)}</blockquote>` : '',
          ].filter(Boolean).join('\n');
        }
        await ctx.telegram.deleteMessage(ctx.chat!.id, progressMsg.message_id).catch(() => {});
        if (photoBuffer) {
          await ctx.replyWithPhoto({ source: photoBuffer }, { caption: infoText, parse_mode: 'HTML' });
          await ctx.reply(card('Lookup Complete', 'i', [['Target', query]], 'Tap Back to return.'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
        } else {
          await ctx.reply(infoText, { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
        }
      } catch (error) {
        await ctx.telegram.editMessageText(ctx.chat!.id, progressMsg.message_id, undefined,
          noticeCard('Lookup Failed', String(error), 'error'),
          { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
        ).catch(() => {});
      }
      return;
    }

    // GC Wizard step: desc
    if (ctx.session?.gcWizard?.step === 'desc') {
      const { sessionId, name } = ctx.session.gcWizard;
      const desc = text.trim() === 'skip' ? '' : text.trim();
      ctx.session.gcWizard = { sessionId, step: 'pfp', name, desc };
      await ctx.reply(
        card('Create GC — Step 3/3', 'GC', [['Name', name], ['Desc', desc || 'None']], 'Send a photo for the group profile picture, or type "skip".'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      );
      return;
    }
    // GC Wizard step: pfp (text skip)
    if (ctx.session?.gcWizard?.step === 'pfp' && text.trim().toLowerCase() === 'skip') {
      const { sessionId, name, desc } = ctx.session.gcWizard;
      delete ctx.session.gcWizard;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Create GC Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
        return;
      }
      await doCreateGroup(ctx, socket, sessionId, name, desc ?? '', null);
      return;
    }
    if (ctx.session?.awaitingCreateGcSessionId) {
      const sessionId = ctx.session.awaitingCreateGcSessionId;
      delete ctx.session.awaitingCreateGcSessionId;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Create GC Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
        return;
      }
      const gcName = text.trim();
      // Step 1: got name -> ask desc
      ctx.session.gcWizard = { sessionId, step: 'desc', name: gcName };
      await ctx.reply(
        card('Create GC — Step 2/3', 'GC', [['Name', gcName]], 'Send the group description, or type "skip".'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      );
      return;
    }

    if (ctx.session?.awaitingLeaveGcSessionId) {
      const sessionId = ctx.session.awaitingLeaveGcSessionId;
      delete ctx.session.awaitingLeaveGcSessionId;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Leave GC Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
        return;
      }
      try {
        let targetJid = text.trim();
        if (targetJid.includes('chat.whatsapp.com/')) {
          const code = targetJid.split('chat.whatsapp.com/')[1]?.split(/[/?]/)[0] ?? '';
          const info = code ? await (socket as unknown as { groupGetInviteInfo(c: string): Promise<{ id: string }> }).groupGetInviteInfo(code).catch(() => null) : null;
          targetJid = info?.id ?? targetJid;
        }
        if (!targetJid.endsWith('@g.us')) throw new Error('Invalid group JID or link');
        await (socket as unknown as { groupLeave(id: string): Promise<void> }).groupLeave(targetJid);
        await ctx.reply(noticeCard('Left Group', `Successfully left ${targetJid}`, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
      } catch (error) {
        await ctx.reply(noticeCard('Leave GC Failed', String(error), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
      }
      return;
    }

    if (ctx.session?.awaitingGcSetSessionId && ctx.session?.awaitingGcSetField) {
      const sessionId = ctx.session.awaitingGcSetSessionId;
      const field = ctx.session.awaitingGcSetField;
      const gcJid = ctx.session.awaitingGcSetJid!;
      delete ctx.session.awaitingGcSetSessionId;
      delete ctx.session.awaitingGcSetField;
      delete ctx.session.awaitingGcSetJid;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML' });
        return;
      }
      try {
        const sock = socket as unknown as {
          groupUpdateSubject(jid: string, subject: string): Promise<void>;
          groupUpdateDescription(jid: string, desc: string): Promise<void>;
          updateProfilePicture(jid: string, buf: Buffer): Promise<void>;
        };
        if (field === 'name') {
          await sock.groupUpdateSubject(gcJid, text.trim());
          await ctx.reply(noticeCard('Group Name Updated', text.trim(), 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
        } else if (field === 'desc') {
          await sock.groupUpdateDescription(gcJid, text.trim());
          await ctx.reply(noticeCard('Group Description Updated', text.trim(), 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
        }
      } catch (error) {
        await ctx.reply(noticeCard('Update Failed', String(error), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      }
      return;
    }

    if (ctx.session?.awaitingPromoteSessionId && ctx.session?.awaitingPromoteGcJid) {
      const sessionId = ctx.session.awaitingPromoteSessionId;
      const gcJid = ctx.session.awaitingPromoteGcJid;
      delete ctx.session.awaitingPromoteSessionId;
      delete ctx.session.awaitingPromoteGcJid;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML' });
        return;
      }
      try {
        const digits = text.trim().replace(/[^0-9]/g, '');
        if (!digits) throw new Error('Invalid number');
        const sock = socket as unknown as {
          groupMetadata(jid: string): Promise<{ participants: { id: string; admin?: string | null; phoneNumber?: string }[] }>;
          groupParticipantsUpdate(jid: string, p: string[], action: string): Promise<unknown>;
          groupInviteCode(jid: string): Promise<string>;
          groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string; addedBy?: string }>>;
          groupRequestParticipantsUpdate(jid: string, participants: string[], action: 'approve' | 'reject'): Promise<unknown>;
        };
        const meta = await sock.groupMetadata(gcJid);
        // Match by phone number — handle LID JIDs using phoneNumber field
        const member = meta.participants.find((p) => {
          const pNum = (p.id.split('@')[0] ?? '').split(':')[0];
          const pPhone = (p.phoneNumber ?? '').replace(/[^0-9]/g, '');
          return pNum === digits || pPhone === digits;
        });

        if (!member) {
          // Check pending join requests first — auto-approve if found
          const pending = await sock.groupRequestParticipantsList(gcJid).catch(() => []);
          const pendingMatch = pending.find((r) => {
            const rNum = (r.jid.split('@')[0] ?? '').split(':')[0];
            return rNum === digits;
          });
          if (pendingMatch) {
            await sock.groupRequestParticipantsUpdate(gcJid, [pendingMatch.jid], 'approve');
            // Now promote
            await sock.groupParticipantsUpdate(gcJid, [pendingMatch.jid], 'promote');
            await ctx.reply(noticeCard('Approved & Promoted', `+${digits} was approved from pending requests and promoted to admin.`, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
          } else {
            // Not in group, not pending — send invite + one-time code
            const inviteCode = await sock.groupInviteCode(gcJid);
            const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
            const joinCode = Math.random().toString(36).slice(2, 8).toUpperCase();
            pendingGcCodes.set(`${sessionId}:${gcJid}`, { code: joinCode, expires: Date.now() + 10 * 60_000 });
            await ctx.reply([
              `<b>+${digits} is not in the group</b>`,
              `Send them this invite link:`,
              `<code>${escape(inviteLink)}</code>`,
              ``,
              `<b>One-Time Admin Code:</b> <code>${joinCode}</code>`,
              `<blockquote expandable>When they join and type the code, they get promoted to admin automatically. Expires in 10 minutes.</blockquote>`,
            ].join('\n'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
          }
        } else if (member.admin) {
          await ctx.reply(noticeCard('Already Admin', `+${digits} is already an admin.`, 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
        } else {
          await sock.groupParticipantsUpdate(gcJid, [member.id], 'promote');
          await ctx.reply(noticeCard('Promoted', `+${digits} is now an admin.`, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
        }
      } catch (error) {
        await ctx.reply(noticeCard('Promote Failed', String(error), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      }
      return;
    }

    if (ctx.session?.awaitingDemoteSessionId && ctx.session?.awaitingDemoteGcJid) {
      const sessionId = ctx.session.awaitingDemoteSessionId;
      const gcJid = ctx.session.awaitingDemoteGcJid;
      delete ctx.session.awaitingDemoteSessionId;
      delete ctx.session.awaitingDemoteGcJid;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML' });
        return;
      }
      try {
        const digits = text.trim().replace(/[^0-9]/g, '');
        if (!digits) throw new Error('Invalid number');
        const sock = socket as unknown as {
          groupMetadata(jid: string): Promise<{ participants: { id: string; admin?: string | null }[] }>;
          groupParticipantsUpdate(jid: string, p: string[], action: string): Promise<unknown>;
        };
        const meta = await sock.groupMetadata(gcJid);
        const member = meta.participants.find((p) => (p.id.split('@')[0] ?? '').split(':')[0] === digits);
        if (!member) throw new Error(`+${digits} is not in the group`);
        if (!member.admin) throw new Error(`+${digits} is not an admin`);
        await sock.groupParticipantsUpdate(gcJid, [member.id], 'demote');
        await ctx.reply(noticeCard('Demoted', `+${digits} is no longer an admin.`, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      } catch (error) {
        await ctx.reply(noticeCard('Demote Failed', String(error), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      }
      return;
    }

    if (ctx.session?.awaitingSetBioSessionId) {
      const sessionId = ctx.session.awaitingSetBioSessionId;
      delete ctx.session.awaitingSetBioSessionId;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Set Bio Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML' });
        return;
      }
      try {
        await (socket as unknown as {
          updateProfileStatus(bio: string): Promise<void>;
        }).updateProfileStatus(text.trim());
        await ctx.reply(
          noticeCard('Bio Updated', `WhatsApp bio set to: ${text.trim()}`, 'success'),
          { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
        );
      } catch (error) {
        logger.error('[Bot] setbio failed', { sessionId, error: String(error) });
        await ctx.reply(
          noticeCard('Set Bio Failed', String(error), 'error'),
          { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
        );
      }
      return;
    }

    if (ctx.session?.awaitingForceJoin) {
      ctx.session.awaitingForceJoin = false;
      const targets = [...new Set(text.split(/[\s,]+/u).map((target) => target.trim()).filter(Boolean))];
      const verified: string[] = [];
      for (const target of targets) {
        try {
          await ctx.telegram.getChat(target);
          verified.push(target);
        } catch (error) {
          logger.warn('[Bot] Force-join target verification failed', { target, error: String(error) });
        }
      }
      updateConfig(ctx.telegramId, { forceJoinTargets: verified });
      await ctx.reply(card('Force Join Updated', '🔐', [['Saved targets', String(verified.length)]], verified.join('\n') || 'Force join is disabled.'), { parse_mode: 'HTML' });
      return;
    }

    if (ctx.session?.awaitingBroadcast) {
      ctx.session.awaitingBroadcast = false;
      const { getAllUserIds } = await import('../services/workspace.js');
      let sent = 0;
      let failed = 0;
      for (const id of getAllUserIds()) {
        try { await ctx.telegram.sendMessage(Number(id), text); sent++; }
        catch { failed++; }
      }
      await ctx.reply(card('Broadcast Complete', '📣', [['Sent', String(sent)], ['Failed', String(failed)]], 'Text broadcast delivered to registered users.'), { parse_mode: 'HTML' });
      return;
    }

    // ── Bridge Mode ──────────────────────────────────────
    const bridgeSessionId = getBridgeSession(ctx.telegramId);
    if (bridgeSessionId) {
      const socket = getSocket(bridgeSessionId);
      if (!socket || isFrozen(bridgeSessionId)) {
        await ctx.reply(noticeCard('Bridge Unavailable', 'This session is disconnected or frozen. Use /unbind to exit bridge mode.', 'warning'), { parse_mode: 'HTML' });
        return;
      }

      try {
        await executeBridgeCommand(
          bridgeSessionId,
          ctx.telegramId,
          text,
          socket,
          async (response) => {
            await ctx.reply(response);
          }
        );
      } catch (error) {
        logger.error('[Bot] Bridge command failed', {
          bridgeSessionId,
          error: String(error),
        });
        await ctx.reply(noticeCard('Bridge Command Failed', 'The WhatsApp command could not be completed.', 'error', String(error)), { parse_mode: 'HTML' });
      }
      return;
    }

    // ── Session Onboarding Wizard ──────────────────────────
    const onboarding = ctx.session?.onboarding;
    if (onboarding?.stage === 'name') {
      const label = text.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (label.length < 2) {
        await ctx.reply(noticeCard('Name Required', 'Use at least 2 characters for the session name.', 'warning'), {
          parse_mode: 'HTML',
          reply_markup: sessionWizardKeyboard(),
        });
        return;
      }
      ctx.session.onboarding = { stage: 'phone', label };
      await ctx.reply(onboardingPhoneCard(label), {
        parse_mode: 'HTML',
        reply_markup: sessionWizardKeyboard(),
      });
      return;
    }

    if (onboarding?.stage === 'phone' && onboarding.label) {
      let phone: string;
      try {
        phone = normalizePairingPhone(text);
      } catch (error) {
        await ctx.reply(noticeCard(
          'Invalid Owner Number',
          error instanceof Error ? error.message : 'Enter a valid international WhatsApp number.',
          'error'
        ), { parse_mode: 'HTML', reply_markup: sessionWizardKeyboard() });
        return;
      }

      const sessionId = makeDraftSessionId(ctx.telegramId, phone);
      const existing = loadSessionMeta(ctx.telegramId, sessionId);
      if (existing?.status === 'open') {
        resetOnboarding(ctx);
        await ctx.reply(noticeCard('Session Already Connected', `${onboarding.label} is already active for ${phone}.`, 'warning'), {
          parse_mode: 'HTML',
          reply_markup: backKeyboard('sessions:list'),
        });
        return;
      }

      saveSessionMeta({
        ...(existing ?? {
          sessionId,
          telegramId: ctx.telegramId,
          autoJoinDone: false,
          errorCount: 0,
        }),
        label: onboarding.label,
        phone,
        status: 'closed',
        pairMethod: existing?.pairMethod ?? 'qr',
      });
      ctx.session.onboarding = { stage: 'method', label: onboarding.label, phone, sessionId };
      await ctx.reply(onboardingMethodCard(onboarding.label, phone), {
        parse_mode: 'HTML',
        reply_markup: sessionPairKeyboard(sessionId),
      });
      return;
    }

    // ── Awaiting Prefix ───────────────��───────────────────
    if (ctx.session?.awaitingGlobalBridge) {
    ctx.session.awaitingGlobalBridge = false;
    const sessionIds = getUserSockets(ctx.telegramId);
    if (sessionIds.length === 0) {
      await ctx.reply(noticeCard('No Active Sessions', 'Connect at least one WhatsApp session first.', 'warning'), { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner) });
      return;
    }
    const progressMsg = await ctx.reply(
      card('Global Bridge Running', '📡', [['Sessions', String(sessionIds.length)], ['Command', text.slice(0, 60)]], 'Executing on all connected sessions…'),
      { parse_mode: 'HTML' }
    );
    const results = await Promise.allSettled(sessionIds.map(async (sessionId) => {
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) throw new Error('Unavailable');
      const replies: string[] = [];
      await executeBridgeCommand(sessionId, ctx.telegramId, text, socket, async (response) => { replies.push(response); });
      return { sessionId, reply: replies.join('\n') || '✅ Done' };
    }));
    const lines = results.map((r, i) => {
      const sid = sessionIds[i] ?? '?';
      if (r.status === 'fulfilled') return `✅ ${sid}\n${r.value.reply}`;
      return `❌ ${sid}: ${String(r.reason)}`;
    });
    await ctx.telegram.editMessageText(
      ctx.chat!.id, progressMsg.message_id, undefined,
      `${header('Global Bridge Complete', '📡')}\n\n${H.blockquote(lines.join('\n\n').slice(0, 3500), true)}`,
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner) }
    ).catch(() =>
      ctx.reply(`${header('Global Bridge Complete', '📡')}\n\n${H.blockquote(lines.join('\n\n').slice(0, 3500), true)}`, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner) })
    );
    return;
  }

  if (ctx.session?.awaitingSupport) {
    ctx.session.awaitingSupport = false;
    const supportId = process.env.TELEGRAM_SUPPORT_CHAT_ID || process.env.TELEGRAM_OWNER_ID;
    if (!supportId) {
      await ctx.reply(noticeCard('Support Not Configured', 'Set TELEGRAM_SUPPORT_CHAT_ID to receive support messages.', 'error'), { parse_mode: 'HTML' });
      return;
    }
    await ctx.telegram.sendMessage(supportId, `Support from ${ctx.telegramId}:\n\n${text}`);
    await ctx.reply(noticeCard('Support Message Sent', 'Your message was delivered to the support team.', 'success'), { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner) });
    return;
  }

  if (ctx.session?.awaitingGlobalMenuUrl) {
    ctx.session.awaitingGlobalMenuUrl = false;
    if (!ctx.isOwner) return;
    const raw = text.trim();
    if (raw.toLowerCase() === 'clear' || raw.toLowerCase() === 'none') {
      clearGlobalMenuUrl();
      await ctx.reply(
        card('Global Menu URL Cleared', '\U0001f517', [], 'The global menu URL has been removed.'),
        { parse_mode: 'HTML', reply_markup: adminPanelKeyboard(false, false) }
      );
    } else {
      const isUrl = /^https?:\/\//i.test(raw);
      const isJid = raw.includes('@g.us') || raw.includes('@newsletter') || raw.includes('@s.whatsapp.net');
      if (!isUrl && !isJid) {
        await ctx.reply(
          noticeCard('Invalid Input', 'Send a WhatsApp JID, a WhatsApp link, or "clear" to remove.', 'error'),
          { parse_mode: 'HTML' }
        );
        return;
      }
      setGlobalMenuUrl(raw);
      await ctx.reply(
        card('Global Menu URL Saved', '\U0001f517', [['Value', raw]], 'Will appear as a link preview on every WhatsApp reply — no raw URL shown.'),
        { parse_mode: 'HTML', reply_markup: adminPanelKeyboard(false, false) }
      );
    }
    return;
  }

  if (ctx.session?.awaitingPrefix) {
    ctx.session.awaitingPrefix = false;
    const requestedPrefix = text.trim();
    const nullPrefix = requestedPrefix.toLowerCase() === 'null';
    const bridgeSessionId = getBridgeSession(ctx.telegramId);
    const activeSessions = getUserSockets(ctx.telegramId);
    const targetSessionId = bridgeSessionId ?? (activeSessions.length === 1 ? activeSessions[0] : undefined);

    if (!targetSessionId) {
      await ctx.reply(noticeCard('Choose A Session First', 'Prefix changes are session-specific. Open a session bridge or keep exactly one WhatsApp session online, then try again.', 'warning'), { parse_mode: 'HTML' });
      return;
    }

    updateSessionConfig(ctx.telegramId, targetSessionId, { prefix: nullPrefix ? '' : requestedPrefix, nullPrefix });
    await ctx.reply(card('Prefix Updated', '✅', [
      ['Session', targetSessionId],
      ['New prefix', nullPrefix ? 'Exact commands only (no prefix)' : requestedPrefix],
    ], 'Only this WhatsApp session was updated; other sessions keep their own prefix.'), { parse_mode: 'HTML' });
    return;
  }

    // ── Auto-detect WA links → add to bucket ─────────────
    const LINK_RE = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/g;
    if (LINK_RE.test(text)) {
      await handleAddLinks(ctx as BotContext, text);
      return;
    }
  });

  bot.on('photo', async (ctx) => {
    if (ctx.session?.awaitingBroadcast) {
      ctx.session.awaitingBroadcast = false;
      const { getAllUserIds } = await import('../services/workspace.js');
      const photo = ctx.message.photo.at(-1);
      if (!photo) return;
      let sent = 0;
      let failed = 0;
      for (const id of getAllUserIds()) {
        try { await ctx.telegram.sendPhoto(Number(id), photo.file_id, { caption: ctx.message.caption }); sent++; }
        catch { failed++; }
      }
      await ctx.reply(card('Broadcast Complete', '📣', [['Sent', String(sent)], ['Failed', String(failed)]], 'Photo broadcast delivered.'), { parse_mode: 'HTML' });
      return;
    }
    // GC Wizard pfp photo handler
    if (ctx.session?.gcWizard?.step === 'pfp') {
      const { sessionId, name, desc } = ctx.session.gcWizard;
      delete ctx.session.gcWizard;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Create GC Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
        return;
      }
      try {
        const photo = ctx.message.photo.at(-1);
        if (!photo) throw new Error('No photo');
        const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
        const res = await fetch(fileUrl.toString());
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const pfpBuffer = Buffer.from(await res.arrayBuffer());
        await doCreateGroup(ctx as never, socket, sessionId, name, desc ?? '', pfpBuffer);
      } catch (error) {
        await ctx.reply(noticeCard('Create GC Failed', String(error), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
      }
      return;
    }

    // Group PFP handler
    if (ctx.session?.awaitingGcPfpSessionId) {
      const sessionId = ctx.session.awaitingGcPfpSessionId;
      const gcJid = ctx.session.awaitingGcPfpJid!;
      delete ctx.session.awaitingGcPfpSessionId;
      delete ctx.session.awaitingGcPfpJid;
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.reply(noticeCard('Group PFP Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML' });
        return;
      }
      try {
        const photo = ctx.message.photo.at(-1);
        if (!photo) throw new Error('No photo provided');
        const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
        const response = await fetch(fileUrl.toString());
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        await (socket as unknown as { updateProfilePicture(jid: string, buf: Buffer, opts?: { hd?: boolean }): Promise<void> }).updateProfilePicture(gcJid, imageBuffer, { hd: true });
        await ctx.reply(noticeCard('Group Photo Updated', gcJid, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      } catch (error) {
        await ctx.reply(noticeCard('Group PFP Failed', String(error), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      }
      return;
    }

    const sessionId = ctx.session?.awaitingProfilePhotoSessionId;
    if (!sessionId) return;
    delete ctx.session.awaitingProfilePhotoSessionId;
    const socket = getSocket(sessionId);
    if (!socket || isFrozen(sessionId)) {
      await ctx.reply(noticeCard('Profile Photo Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML' });
      return;
    }
    try {
      // Use highest-res photo Telegram provides (last in array = largest)
      const photo = ctx.message.photo.at(-1);
      if (!photo) throw new Error('No photo provided');
      const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
      const response = await fetch(fileUrl.toString());
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const imageBuffer = Buffer.from(await response.arrayBuffer());
      const ownJid = (socket as { user?: { id?: string } }).user?.id;
      if (!ownJid) throw new Error('WhatsApp JID unavailable');
      // Pass buffer with hd:true — crysnovax Baileys preserves aspect ratio, caps at 1920px, no square crop
      await (socket as unknown as {
        updateProfilePicture(jid: string, content: Buffer, dimensions?: { hd?: boolean; width?: number; height?: number }): Promise<void>;
      }).updateProfilePicture(ownJid, imageBuffer, { hd: true });
      await ctx.reply(
        noticeCard('Profile Photo Updated', 'Full HD, no crop applied.', 'success'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      );
    } catch (error) {
      logger.error('[Bot] setpfp failed', { sessionId, error: String(error) });
      await ctx.reply(
        noticeCard('Profile Photo Failed', String(error), 'error'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      );
    }
  });


  bot.on('document', async (ctx) => {
    if (ctx.session?.awaitingBroadcast) {
      ctx.session.awaitingBroadcast = false;
      const { getAllUserIds } = await import('../services/workspace.js');
      let sent = 0;
      let failed = 0;
      for (const id of getAllUserIds()) {
        try { await ctx.telegram.sendDocument(Number(id), ctx.message.document.file_id, { caption: ctx.message.caption }); sent++; }
        catch { failed++; }
      }
      await ctx.reply(card('Broadcast Complete', '📣', [['Sent', String(sent)], ['Failed', String(failed)]], 'Document broadcast delivered.'), { parse_mode: 'HTML' });
      return;
    }
    const name = ctx.message.document.file_name ?? '';
    if (!/\.(txt|csv|json)$/iu.test(name)) return;
    try {
      const fileUrl = await ctx.telegram.getFileLink(ctx.message.document.file_id);
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error(`Telegram download failed with ${response.status}`);
      const { importLinksToMainBucket } = await import('../services/importer.js');
      const result = importLinksToMainBucket(ctx.telegramId, await response.text());
      await ctx.reply(card('Document Imported', '📥', [['Extracted', String(result.extracted)], ['Unique', String(result.unique)], ['Added', String(result.added)], ['Duplicates', String(result.dupes)]], 'Links were parsed, deduplicated, and inserted into Main Bucket.'), { parse_mode: 'HTML' });
    } catch (error) {
      await ctx.reply(noticeCard('Import Failed', 'The document could not be imported.', 'error', String(error)), { parse_mode: 'HTML' });
    }
  });

  // ── Callback Query Router ──────────────────────────────

  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string }).data;
    if (!data) return;

    const bc = ctx as BotContext;

    // Pattern: action:param1:param2:...
    const [action, ...params] = data.split(':');

    try {
      await ctx.answerCbQuery().catch(() => {});
      await routeCallback(bc, action!, params);
    } catch (err) {
      logger.error('[Bot] Callback error', { data, err: String(err) });
      await ctx.reply(noticeCard('Action Failed', 'The selected action could not be completed.', 'error', String(err)), {
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  });

  // ── Force Join Verify ──────────────────────────────────

  bot.action('verify:joined', async (ctx) => {
    await ctx.answerCbQuery('Checking membership…');
    // Re-trigger the middleware on next interaction — just dismiss
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(
      mainMenu(ctx.telegramId, ctx.isOwner),
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.isOwner) }
    );
  });

  // ── Error Handler ──────────────────────────────────────

  bot.catch((err, ctx) => {
    logger.error('[Bot] Unhandled error', {
      err: String(err),
      update: ctx.updateType,
    });
  });

  return bot;
}

// ── Callback Route Table ──────────────────────────────────

async function routeCallback(
  ctx: BotContext,
  action: string,
  params: string[]
): Promise<void> {
  // ── Menu ──
  if (action === 'menu' && params[0] === 'main') {
    await ctx.editMessageText(mainMenu(ctx.telegramId, ctx.isOwner), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(ctx.isOwner),
    });
    return;
  }

  // ── Help and Status ──
  if (action === 'help') {
    const stickerHelp = params[0] === 'stickers';
    await ctx.editMessageText(
      stickerHelp
        ? `${header('Sticker Macro Help', '🎭')}\n\nUnbound stickers stay silent. Reply directly to the sticker with ${H.code('.setcmd [command]')} to bind it.`
        : helpText(ctx.isOwner),
      {
        parse_mode: 'HTML',
        reply_markup: stickerHelp ? backKeyboard('settings:macros') : helpKeyboard(),
      }
    );
    return;
  }

  if (action === 'status' && params[0] === 'overview') {
    const sessionIds = getUserSockets(ctx.telegramId);
    const active = sessionIds.filter((id) => Boolean(getSocket(id)) && !isFrozen(id)).length;
    const frozen = sessionIds.filter((id) => isFrozen(id)).length;
    const bucketTotal = loadBucket(ctx.telegramId, 'main').length;
    await ctx.editMessageText(
      card('System Status', '📊', [
        ['Bot', 'Online'],
        ['Sessions', String(sessionIds.length)],
        ['Active', String(active)],
        ['Frozen', String(frozen)],
        ['Pending links', String(bucketTotal)],
      ], 'Use Refresh to request the latest runtime snapshot.'),
      { parse_mode: 'HTML', reply_markup: statusKeyboard() }
    );
    return;
  }

  // ── Sessions ──
  if (action === 'sessions') {
    const page = parseInt(params[1] ?? '0', 10);
    await handleSessionsList(ctx, page);
    return;
  }

  if (action === 'session') {
    if (params[0] === 'new' && params[1] === 'cancel') {
      const draftSessionId = ctx.session.onboarding?.sessionId;
      if (draftSessionId && loadSessionMeta(ctx.telegramId, draftSessionId)?.status === 'closed') {
        purgeSession(ctx.telegramId, draftSessionId);
      }
      resetOnboarding(ctx);
      await handleSessionsList(ctx);
      return;
    }

    if (params[0] === 'new') {
      ctx.session.onboarding = { stage: 'name' };
      await ctx.editMessageText(onboardingNameCard(), {
        parse_mode: 'HTML',
        reply_markup: sessionWizardKeyboard(),
      });
      return;
    }

    const sessionId = params[0]!;
    const sub = params[1];
    if (!sessionId || !sub) return;

    if (sub === 'menu') {
      const { sessionMenuKeyboard } = await import('./ui/keyboards.js');
      const { loadSessionMeta } = await import('../services/workspace.js');
      const ownerId = sessionOwner(ctx, sessionId);
      const meta = loadSessionMeta(ownerId, sessionId);
      if (!meta) { await ctx.answerCbQuery('Session not found'); return; }
      const { sessionCard } = await import('../utils/formatter.js');
      await ctx.editMessageText(
        sessionCard({ sessionId, label: meta.label, phone: meta.phone, status: meta.status, paired: meta.status === 'open' }),
        { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
      ).catch(() => {});
      return;
    }
    if (sub === 'info') { await handleSessionInfo(ctx, sessionId); return; }
    if (sub === 'groups') {
      const page = parseInt(params[2] ?? '0', 10);
      const socket = getSocket(sessionId);
      if (!socket) {
        await ctx.editMessageText(noticeCard('Session Groups', 'Connect this session before requesting its group list.', 'warning'), {
          parse_mode: 'HTML',
          reply_markup: backKeyboard(`session:${sessionId}:menu`),
        });
        return;
      }
      await ctx.answerCbQuery('Fetching groups...').catch(() => {});
      const groups = Object.values(await socket.groupFetchAllParticipating());
      const PAGE_SIZE = 30;
      const total = groups.length;
      const slice = groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const names = slice.map((g, i) => `${page * PAGE_SIZE + i + 1}. ${escape(g.subject)}`);
      const nav: { text: string; callback_data: string }[] = [];
      if (page > 0) nav.push({ text: '◀ Prev', callback_data: `session:${sessionId}:groups:${page - 1}` });
      if ((page + 1) * PAGE_SIZE < total) nav.push({ text: 'Next ▶', callback_data: `session:${sessionId}:groups:${page + 1}` });
      const keyboard = {
        inline_keyboard: [
          ...(nav.length ? [nav] : []),
          [{ text: '🔙 Back', callback_data: `session:${sessionId}:menu` }],
        ],
      };
      const text = [
        card('Session Groups', '📋', [['Total', String(total)], ['Page', `${page + 1}/${Math.ceil(total / PAGE_SIZE) || 1}`]], total ? 'Paginated — use arrows to browse.' : 'No groups found.'),
        names.length ? H.blockquote(names.join('\n'), true) : '',
      ].filter(Boolean).join('\n\n');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
      return;
    }
    if (sub === 'freeze') { await handleFreezeSession(ctx, sessionId); return; }
    if (sub === 'unfreeze') { await handleUnfreezeSession(ctx, sessionId); return; }
    if (sub === 'reinit') { await handleReinitSession(ctx, sessionId); return; }
    if (sub === 'purge' && params[2] === 'confirm') { await handlePurgeConfirm(ctx, sessionId); return; }
    if (sub === 'purge') { await handlePurgeSession(ctx, sessionId); return; }
    if (sub === 'pfp') {
      const operation = params[2];
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.answerCbQuery('Session is not connected', { show_alert: true }).catch(() => {});
        return;
      }
      if (operation === 'set') {
        ctx.session.awaitingProfilePhotoSessionId = sessionId;
        await ctx.editMessageText(card('Set WhatsApp Profile Photo', '🖼', [['Session', sessionId]], 'Send one photo now. Use a square image for the best result.'), {
          parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`),
        });
      } else if (operation === 'get') {
        const ownJid = (socket as { user?: { id?: string } }).user?.id;
        if (!ownJid) { await ctx.answerCbQuery('JID unavailable', { show_alert: true }).catch(() => {}); return; }
        try {
          const ppUrl = await (socket as unknown as { profilePictureUrl(jid: string, type: string): Promise<string | null> }).profilePictureUrl(ownJid, 'image').catch(() => null);
          if (!ppUrl) {
            await ctx.answerCbQuery('No profile photo set', { show_alert: true }).catch(() => {});
            return;
          }
          const res = await fetch(ppUrl);
          if (!res.ok) throw new Error(`Download failed: ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          await ctx.replyWithPhoto({ source: buf }, {
            caption: `<b>Current Profile Photo</b>\n<code>${escape(sessionId)}</code>`,
            parse_mode: 'HTML',
          });
          // Send separate navigable message — can't editMessageText on a photo
          await ctx.reply(card('Profile Photo', 'PFP', [['Session', sessionId]], 'Tap Back to return.'), {
            parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`),
          });
        } catch (error) {
          await ctx.reply(noticeCard('Get PFP Failed', String(error), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) });
        }
      } else if (operation === 'remove') {
        const ownJid = (socket as { user?: { id?: string } }).user?.id;
        if (!ownJid) throw new Error('The WhatsApp account JID is unavailable');
        await (socket as unknown as { removeProfilePicture(jid: string): Promise<void> }).removeProfilePicture(ownJid);
        await ctx.editMessageText(noticeCard('Profile Photo Removed', 'The WhatsApp profile photo was removed.', 'success'), {
          parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`),
        });
      }
      return;
    }
    if (sub === 'setname') {
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.answerCbQuery('Session not connected', { show_alert: true }).catch(() => {});
        return;
      }
      ctx.session.awaitingSetNameSessionId = sessionId;
      await ctx.editMessageText(
        card('Set WhatsApp Display Name', '✏️', [['Session', sessionId]], 'Send the new name now. No character limit — WhatsApp accepts any length.'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      ).catch(() => {});
      return;
    }
    if (sub === 'setbio') {
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) {
        await ctx.answerCbQuery('Session not connected', { show_alert: true }).catch(() => {});
        return;
      }
      ctx.session.awaitingSetBioSessionId = sessionId;
      await ctx.editMessageText(
        card('Set WhatsApp Bio', '📝', [['Session', sessionId]], 'Send your new bio text now. This appears on your WhatsApp profile.'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      ).catch(() => {});
      return;
    }
    if (sub === 'collect') {
      const enabled = params[2] === 'on' ? true : params[2] === 'off' ? false : undefined;
      await handleLinkCollection(ctx, sessionId, enabled);
      return;
    }
    if (sub === 'joinmgr') { await handleJoinManager(ctx, sessionId); return; }
    if (sub === 'join') {
      const operation = params[2] as 'start' | 'pause' | 'stop' | undefined;
      await handleJoinManager(ctx, sessionId, operation);
      return;
    }
    if (sub === 'bridge') { await handleBridgeSession(ctx, sessionId); return; }
    if (sub === 'wainfo') {
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) { await ctx.answerCbQuery('Session not connected', { show_alert: true }).catch(() => {}); return; }
      ctx.session.awaitingWaInfoSessionId = sessionId;
      await ctx.editMessageText(
        card('WA Lookup', 'Search', [['Session', sessionId]], 'Send a number (+234...), group JID (xxx@g.us), or invite link (chat.whatsapp.com/...).'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      ).catch(() => {});
      return;
    }
    if (sub === 'creategc') {
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) { await ctx.answerCbQuery('Session not connected', { show_alert: true }).catch(() => {}); return; }
      ctx.session.awaitingCreateGcSessionId = sessionId;
      await ctx.editMessageText(
        card('Create WhatsApp Group', 'GC', [['Session', sessionId]], 'Send the group name. An invite link and one-time admin code will be generated.'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      ).catch(() => {});
      return;
    }
    if (sub === 'leavegc') {
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) { await ctx.answerCbQuery('Session not connected', { show_alert: true }).catch(() => {}); return; }
      ctx.session.awaitingLeaveGcSessionId = sessionId;
      await ctx.editMessageText(
        card('Leave WhatsApp Group', 'Exit', [['Session', sessionId]], 'Send the group JID (xxx@g.us) or invite link to leave.'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:menu`) }
      ).catch(() => {});
      return;
    }
    if (sub === 'mygroups') {
      const socket = getSocket(sessionId);
      if (!socket) { await ctx.answerCbQuery('Session not connected', { show_alert: true }).catch(() => {}); return; }
      const page = parseInt(params[2] ?? '0', 10);
      const allGroups = Object.values(await socket.groupFetchAllParticipating());
      const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
      const selfNum = ownJid.split('@')[0]?.split(':')[0] ?? '';
      // Match admin groups — check phone number, full JID, and LID variants
      const adminGroups = allGroups.filter((g) => {
        const parts = (g as unknown as { participants: { id: string; admin?: string | null; phoneNumber?: string }[] }).participants;
        // Check if any admin participant matches our identity
        return parts.some((p) => {
          if (!p.admin) return false;
          const pNum = (p.id.split('@')[0] ?? '').split(':')[0];
          const pPhone = (p.phoneNumber ?? '').replace(/[^0-9]/g, '');
          return (
            pNum === selfNum ||
            p.id === ownJid ||
            p.id.startsWith(selfNum + '@') ||
            p.id.startsWith(selfNum + ':') ||
            (pPhone && pPhone === selfNum)
          );
        });
      });
      // Fallback: if Baileys uses LID and we can't match, check group's own admin field
      const groupsToShow = adminGroups.length > 0 ? adminGroups : allGroups.filter((g) => {
        const raw = g as unknown as { admins?: string[]; participants: { id: string; admin?: string | null }[] };
        // superadmin = group creator, always admin
        return raw.participants.some((p) => p.admin === 'superadmin' && (
          (p.id.split('@')[0] ?? '').split(':')[0] === selfNum ||
          p.id === ownJid
        ));
      });
      logger.info('[MyGroups]', { selfNum, ownJid, total: allGroups.length, adminFound: adminGroups.length });
      const PAGE = 20;
      const total = groupsToShow.length;
      const slice = groupsToShow.slice(page * PAGE, (page + 1) * PAGE);
      const nav: { text: string; callback_data: string }[] = [];
      if (page > 0) nav.push({ text: 'Prev', callback_data: `session:${sessionId}:mygroups:${page - 1}` });
      if ((page + 1) * PAGE < total) nav.push({ text: 'Next', callback_data: `session:${sessionId}:mygroups:${page + 1}` });
      const gcButtons = slice.map((g) => [{
        text: (g as unknown as { subject: string }).subject,
        callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, g.id)}`,
      }]);
      await ctx.editMessageText(
        card('My Groups (Admin)', 'GC', [['Total', String(total)], ['Page', `${page + 1}/${Math.ceil(total / PAGE) || 1}`]], total ? 'Groups where this session is admin.' : 'Not admin in any group.'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              ...gcButtons,
              ...(nav.length ? [nav] : []),
              [{ text: 'Back', callback_data: `session:${sessionId}:menu` }],
            ],
          },
        }
      ).catch(() => {});
      return;
    }
    return;
  }

  // ── Group Settings ──
  if (action === 'gcset') {
    const sessionId = params[0]!;
    const gcJidRaw = params[1]!;
    const sub2 = params[2];
    if (!sessionId || !gcJidRaw) return;
    // Resolve short key back to full JID
    const gcJid = gcJidRaw.includes('@') ? gcJidRaw : (resolveGcJid(sessionId, gcJidRaw) ?? gcJidRaw);
    const socket = getSocket(sessionId);
    if (!socket || isFrozen(sessionId)) { await ctx.answerCbQuery('Session not connected', { show_alert: true }).catch(() => {}); return; }
    const sock = socket as unknown as {
      groupMetadata(jid: string): Promise<{ subject: string; desc?: string; participants: { id: string; admin?: string | null }[]; creation?: number }>;
      groupSettingUpdate(jid: string, setting: string): Promise<void>;
      groupJoinApprovalMode(jid: string, mode: string): Promise<void>;
      groupMemberAddMode(jid: string, mode: string): Promise<void>;
      groupLeave(id: string): Promise<void>;
      groupParticipantsUpdate(jid: string, p: string[], action: string): Promise<unknown>;
      profilePictureUrl(jid: string, type: string): Promise<string | null>;
    };

    if (!sub2) {
      // Show group settings menu
      const meta = await sock.groupMetadata(gcJid).catch(() => null);
      if (!meta) { await ctx.answerCbQuery('Could not fetch group', { show_alert: true }).catch(() => {}); return; }
      const admins = meta.participants.filter((p) => p.admin).map((p) => { const phone = (p as unknown as { phoneNumber?: string }).phoneNumber?.replace(/[^0-9]/g, '') || (p.id.split('@')[0] ?? '').split(':')[0]; return `+${phone}`; }).join(', ') || 'None';
      const text = [
        `<b>Group Settings</b>`,
        `<code>------------------------------</code>`,
        `<b>Name:</b> ${escape(meta.subject)}`,
        `<b>Members:</b> ${meta.participants.length}`,
        `<b>Admins:</b> ${escape(admins)}`,
        meta.desc ? `<b>Desc:</b> <blockquote expandable>${escape(meta.desc)}</blockquote>` : '',
        `<b>JID:</b> <code>${escape(gcJid)}</code>`,
      ].filter(Boolean).join('\n');
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Edit Name', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:name` }, { text: 'Edit Desc', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:desc` }],
            [{ text: 'Set PFP', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:pfp` }, { text: 'Get PFP', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:getpfp` }],
            [{ text: 'Promote Admin', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:promote` }, { text: 'Demote Admin', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:demote` }],
            [{ text: 'Join Approval ON', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:approval:on` }, { text: 'Join Approval OFF', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:approval:off` }],
            [{ text: 'Members Add ON', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:memberadd:on` }, { text: 'Members Add OFF', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:memberadd:off` }],
            [{ text: 'Leave Group', callback_data: `gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}:leave` }],
            [{ text: 'Back', callback_data: `session:${sessionId}:mygroups` }],
          ],
        },
      }).catch(() => {});
      return;
    }

    if (sub2 === 'name') {
      ctx.session.awaitingGcSetSessionId = sessionId;
      ctx.session.awaitingGcSetField = 'name';
      ctx.session.awaitingGcSetJid = gcJid;
      await ctx.editMessageText(card('Edit Group Name', 'GC', [['Group', gcJid]], 'Send the new group name.'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) }).catch(() => {});
      return;
    }
    if (sub2 === 'desc') {
      ctx.session.awaitingGcSetSessionId = sessionId;
      ctx.session.awaitingGcSetField = 'desc';
      ctx.session.awaitingGcSetJid = gcJid;
      await ctx.editMessageText(card('Edit Group Description', 'GC', [['Group', gcJid]], 'Send the new description.'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) }).catch(() => {});
      return;
    }
    if (sub2 === 'pfp') {
      ctx.session.awaitingGcPfpSessionId = sessionId;
      ctx.session.awaitingGcPfpJid = gcJid;
      await ctx.editMessageText(card('Set Group Photo', 'GC', [['Group', gcJid]], 'Send a photo now.'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) }).catch(() => {});
      return;
    }
    if (sub2 === 'getpfp') {
      try {
        const ppUrl = await sock.profilePictureUrl(gcJid, 'image').catch(() => null);
        if (!ppUrl) { await ctx.answerCbQuery('No group photo set', { show_alert: true }).catch(() => {}); return; }
        const res = await fetch(ppUrl);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await ctx.replyWithPhoto({ source: buf }, { caption: `<b>Group Photo</b>\n<code>${escape(gcJid)}</code>`, parse_mode: 'HTML' });
        await ctx.reply('Back', { reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      } catch (error) {
        await ctx.reply(noticeCard('Get PFP Failed', String(error), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      }
      return;
    }
    if (sub2 === 'promote') {
      ctx.session.awaitingPromoteSessionId = sessionId;
      ctx.session.awaitingPromoteGcJid = gcJid;
      await ctx.editMessageText(card('Promote to Admin', 'GC', [['Group', gcJid]], 'Send the WhatsApp number to promote.'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) }).catch(() => {});
      return;
    }
    if (sub2 === 'demote') {
      ctx.session.awaitingDemoteSessionId = sessionId;
      ctx.session.awaitingDemoteGcJid = gcJid;
      await ctx.editMessageText(card('Demote Admin', 'GC', [['Group', gcJid]], 'Send the WhatsApp number to demote.'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) }).catch(() => {});
      return;
    }
    if (sub2 === 'approval') {
      const mode = params[3] === 'on' ? 'on' : 'off';
      try {
        await sock.groupJoinApprovalMode(gcJid, mode);
        await ctx.answerCbQuery(`Join Approval ${mode === 'on' ? 'ON' : 'OFF'}`, { show_alert: true }).catch(() => {});
      } catch (err) {
        await ctx.answerCbQuery(`Failed: ${String(err).slice(0, 50)}`, { show_alert: true }).catch(() => {});
      }
      await routeCallback(ctx, 'gcset', [sessionId, storeGcJid(sessionId, gcJid)]);
      return;
    }
    if (sub2 === 'memberadd') {
      const mode = params[3] === 'on' ? 'all_member_add' : 'admin_add';
      try {
        await sock.groupMemberAddMode(gcJid, mode);
        await ctx.answerCbQuery(`Member Add: ${params[3] === 'on' ? 'All Members' : 'Admins Only'}`, { show_alert: true }).catch(() => {});
      } catch (err) {
        await ctx.answerCbQuery(`Failed: ${String(err).slice(0, 50)}`, { show_alert: true }).catch(() => {});
      }
      await routeCallback(ctx, 'gcset', [sessionId, storeGcJid(sessionId, gcJid)]);
      return;
    }
    if (sub2 === 'leave') {
      await sock.groupLeave(gcJid);
      await ctx.editMessageText(noticeCard('Left Group', gcJid, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:mygroups`) }).catch(() => {});
      return;
    }
    return;
  }

  // ── Pairing ──
  if (action === 'pair') {
    const method = params[0];
    const sessionId = params[1];
    if (!sessionId) return;
    const meta = loadSessionMeta(ctx.telegramId, sessionId);
    if (!meta) {
      await ctx.answerCbQuery('Session not found', { show_alert: true }).catch(() => {});
      return;
    }
    resetOnboarding(ctx);
    if (method === 'code') await handlePairingCode(ctx, sessionId, meta.phone);
    else if (method === 'qr') await handleNewSession(ctx, meta.phone, meta.label);
    return;
  }

  // ── Bucket ──
  if (action === 'bucket') {
    const sub = params[0];
    if (sub === 'status') { await handleBucketStatus(ctx); return; }
    if (sub === 'view') { await handleBucketView(ctx, params[1] as 'main' | 'active' | 'dead', 0); return; }
    if (sub === 'filter') {
      if (params[1] === 'start') await handleStartFilter(ctx);
      else if (params[1] === 'http') await handleStartFilterHttp(ctx);
      else await handleStopFilter(ctx);
      return;
    }
    if (sub === 'export') { await handleExportBucket(ctx, params[1] as 'txt' | 'csv' | 'html'); return; }
    if (sub === 'purge' && params[1] === 'dead') { await handlePurgeDead(ctx); return; }
    if (sub === 'merge') { await handleMergeBuckets(ctx); return; }
    if (sub === 'page') { await handleBucketView(ctx, params[1] as 'main' | 'active' | 'dead', parseInt(params[2] ?? '0', 10)); return; }
    return;
  }

  // ── Bridge ──
  if (action === 'bridge' && params[0] === 'exit') {
    handleBridgeExit(ctx.telegramId);
    await ctx.answerCbQuery('Bridge exited');
    await ctx.editMessageText(mainMenu(ctx.telegramId, ctx.isOwner), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(ctx.isOwner),
    });
    return;
  }

  // ── Admin ──
  if (action === 'admin') {
    const sub = params[0];
    if (sub === 'panel') { await handleAdminPanel(ctx); return; }
    if (sub === 'users') { await handleAdminUsers(ctx, parseInt(params[1] ?? '0', 10)); return; }
    if (sub === 'user') { await handleAdminUserMenu(ctx, params[1]!); return; }
    if (sub === 'ban') { await handleBanUser(ctx, params[1]!, true); return; }
    if (sub === 'unban') { await handleBanUser(ctx, params[1]!, false); return; }
    if (sub === 'inspect') { await handleInspectUser(ctx, params[1]!); return; }
    if (sub === 'purge_sessions') { await handlePurgeUserSessions(ctx, params[1]!); return; }
    if (sub === 'purge_confirm') { await adminPurgeConfirm(ctx, params[1]!); return; }
    if (sub === 'master') {
      if (params[1] === 'bucket') await handleMasterBucket(ctx);
      else if (params[1] === 'export') {
        const { getMasterActiveBucket } = await import('../services/tri-bucket.js');
        const { getAllUserIds, exportDir } = await import('../services/workspace.js');
        const master = getMasterActiveBucket(getAllUserIds());
        const { saveBucket } = await import('../services/workspace.js');
        saveBucket(ctx.telegramId, 'active', master);
        await handleExportBucket(ctx, params[2] as 'txt' ?? 'txt');
      }
      return;
    }
    if (sub === 'omni') { await handleOmniBridge(ctx); return; }
    if (sub === 'forcejoin') {
      ctx.session.awaitingForceJoin = true;
      await ctx.editMessageText(card('Force Join Targets', '🔐', [['Mode', 'Replace all targets']], 'Send @channels or numeric chat IDs separated by spaces/commas. Every target is verified before saving.'), { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') });
      return;
    }
    if (sub === 'broadcast') {
      ctx.session.awaitingBroadcast = true;
      await ctx.editMessageText(card('Broadcast', '📣', [['Recipients', 'All registered users']], 'Send broadcast text or a photo now.'), { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') });
      return;
    }
    if (sub === 'pause') { await handleGlobalPause(ctx, params[1] !== 'off'); return; }
    if (sub === 'maintenance') { await handleMaintenanceToggle(ctx, params[1] !== 'off'); return; }
    if (sub === 'stats') { await handlePlatformStats(ctx); return; }
    if (sub === 'update') { await handleUpdateBot(ctx); return; }
    if (sub === 'restart') { await handleRestartBot(ctx); return; }
    if (sub === 'menuurl') {
      if (!ctx.isOwner) return;
      const currentUrl = getGlobalMenuUrl();
      if (params[1] === 'clear') {
        clearGlobalMenuUrl();
        await ctx.editMessageText(
          card('Global Menu URL Cleared', '🔗', [], 'WhatsApp responses will no longer include a menu URL.'),
          { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') }
        );
        return;
      }
      ctx.session.awaitingGlobalMenuUrl = true;
      await ctx.editMessageText(
        card(
          'Global Menu URL',
          '🔗',
          [['Current URL', currentUrl ?? 'Not set']],
          currentUrl
            ? 'Send a new URL to replace it, or send "clear" to remove it.'
            : 'Send an HTTP/HTTPS URL. It will be appended to every WhatsApp response with a link preview.'
        ),
        {
          parse_mode: 'HTML',
          reply_markup: currentUrl
            ? { inline_keyboard: [[{ text: '🗑 Clear URL', callback_data: 'admin:menuurl:clear' }], [{ text: '🔙 Back', callback_data: 'admin:panel' }]] }
            : { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin:panel' }]] },
        }
      );
      return;
    }
    return;
  }

  // ── Global Bridge, Sleep, and Support ──
  if (action === 'bridge' && params[0] === 'global') {
    ctx.session.awaitingGlobalBridge = true;
    await ctx.editMessageText(card('Global Bridge', '📡', [['Connected sessions', String(getUserSockets(ctx.telegramId).length)]], 'Send one registered WhatsApp command. It will run independently on every available session.'), {
      parse_mode: 'HTML', reply_markup: backKeyboard('menu:main'),
    });
    return;
  }
  if (action === 'sleep') {
    const { updateConfig } = await import('../services/workspace.js');
    const current = loadConfig(ctx.telegramId);
    const sleeping = params[0] === 'on' ? true : params[0] === 'off' ? false : current.sleeping;
    if (params[0] === 'on' || params[0] === 'off') updateConfig(ctx.telegramId, { sleeping });
    await ctx.editMessageText(card('Sleep Mode', '🌙', [['Status', sleeping ? 'Sleeping' : 'Active']], sleeping ? 'WhatsApp command activity is silently ignored across all sessions.' : 'All sessions can process authorized commands.'), {
      parse_mode: 'HTML', reply_markup: sleepKeyboard(Boolean(sleeping)),
    });
    return;
  }
  if (action === 'support') {
    if (params[0] === 'start') {
      ctx.session.awaitingSupport = true;
      await ctx.editMessageText(card('Contact Support', '🛟', [], 'Send your support message now. It will be forwarded with your Telegram ID.'), { parse_mode: 'HTML', reply_markup: backKeyboard('support:menu') });
    } else {
      await ctx.editMessageText(card('Support', '🛟', [], 'Contact the support team without leaving the bot.'), { parse_mode: 'HTML', reply_markup: supportKeyboard() });
    }
    return;
  }

  // ── Settings ──
  if (action === 'settings') {
    const sub = params[0];
    if (sub === 'menu') {
      const bridgeSessionId = getBridgeSession(ctx.telegramId);
      const activeSessions = getUserSockets(ctx.telegramId);
      const targetSessionId = bridgeSessionId ?? (activeSessions.length === 1 ? activeSessions[0] : undefined);
      const config = targetSessionId ? loadSessionConfig(ctx.telegramId, targetSessionId) : loadConfig(ctx.telegramId);
      await ctx.editMessageText(card('Settings', '⚙️', [['Prefix', config.prefix], ['Prefix scope', targetSessionId ?? 'Select one active session']], 'Choose what you want to configure.'), {
        parse_mode: 'HTML',
        reply_markup: settingsKeyboard(config),
      });
      return;
    }
    if (sub === 'prefix') {
      const bridgeSessionId = getBridgeSession(ctx.telegramId);
      const activeSessions = getUserSockets(ctx.telegramId);
      const targetSessionId = bridgeSessionId ?? (activeSessions.length === 1 ? activeSessions[0] : undefined);
      if (!targetSessionId) {
        await ctx.answerCbQuery('Choose one session first', { show_alert: true }).catch(() => {});
        await ctx.editMessageText(noticeCard('Choose A Session First', 'Prefix changes are session-specific. Open a session bridge or keep exactly one WhatsApp session online, then retry.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard('settings:menu') });
        return;
      }
      ctx.session.awaitingPrefix = true;
      await ctx.editMessageText(
        card('Change Prefix', '🔤', [['Session', targetSessionId], ['Current', loadSessionConfig(ctx.telegramId, targetSessionId).prefix]], 'Send a new prefix such as ! or /. Send null to enable always-listen mode.'),
        { parse_mode: 'HTML', reply_markup: backKeyboard('settings:menu') }
      );
      return;
    }
    if (sub === 'macros') {
      const bridgeSessionId = getBridgeSession(ctx.telegramId);
      const activeSessions = getUserSockets(ctx.telegramId);
      const targetSessionId = bridgeSessionId ?? (activeSessions.length === 1 ? activeSessions[0] : undefined);
      const macroConfig = targetSessionId ? loadSessionConfig(ctx.telegramId, targetSessionId) : loadConfig(ctx.telegramId);
      const macroCount = Object.keys(macroConfig.stickerMacros ?? {}).length;
      await ctx.editMessageText(
        `${header('Sticker Macros', '🎭')}

${H.bold('Bindings:')} ${macroCount}
${targetSessionId ? `${H.bold('Session:')} ${H.code(targetSessionId)}\n` : ''}
Reply directly to a WhatsApp sticker with ${H.code(`${macroConfig.prefix || ''}setcmd [command]`)}. Unbound stickers remain silent.`,
        { parse_mode: 'HTML', reply_markup: stickerMacrosKeyboard() }
      );
      return;
    }
    if (sub === 'disabled') {
      await ctx.answerCbQuery('This option is coming soon', { show_alert: true }).catch(() => {});
      return;
    }
    if (['notifications', 'collection', 'validation'].includes(sub ?? '')) {
      const { updateConfig } = await import('../services/workspace.js');
      const config = loadConfig(ctx.telegramId);
      if (sub === 'notifications') updateConfig(ctx.telegramId, { notificationsEnabled: config.notificationsEnabled === false });
      if (sub === 'collection') updateConfig(ctx.telegramId, { defaultLinkCollection: !config.defaultLinkCollection });
      if (sub === 'validation') updateConfig(ctx.telegramId, { autoValidationEnabled: !config.autoValidationEnabled });
      const updated = loadConfig(ctx.telegramId);
      await ctx.editMessageText(card('Settings', '⚙️', [['Prefix', updated.prefix]], 'Setting updated.'), {
        parse_mode: 'HTML', reply_markup: settingsKeyboard(updated),
      });
      return;
    }
    return;
  }

  // Default fallback: never leave a rendered button apparently unresponsive.
  await ctx.reply(noticeCard(
    'Unsupported Action',
    'This button is not available in the current bot version.',
    'warning',
    [action, ...params].join(':')
  ), { parse_mode: 'HTML' });
}

// ── Alert Sender (used by socket manager) ────────────────

export function createAlertSender(
  bot: Telegraf<BotContext>
): (telegramId: string, msg: string) => Promise<void> {
  return async (telegramId, msg) => {
    try {
      await bot.telegram.sendMessage(parseInt(telegramId, 10), msg, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.warn('[Bot] Failed to send alert', { telegramId, err: String(err) });
    }
  };
}

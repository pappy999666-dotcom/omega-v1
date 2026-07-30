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
  setGroupBridge,
  getGroupBridge,
  clearGroupBridge,
} from './handlers/group-bridge.js';
import { executeGroupBridgeCommand } from '../whatsapp/event-handlers.js';
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
  handleLogStream,
  stopLogStream,
} from './handlers/admin.js';
import {
  mainMenuKeyboard,
  helpKeyboard,
  helpCategoryKeyboard,
  statusKeyboard,
  stickerMacrosKeyboard,
  backKeyboard,
  sessionPairKeyboard,
  sessionWizardKeyboard,
  sleepKeyboard,
  supportKeyboard,
  settingsKeyboard,
  adminPanelKeyboard,
  btn,
  copyBtn,
  groupBridgeActiveKeyboard,
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
import { cmdBlockAll } from '../whatsapp/commands/group-moderation.js';
import { executeBridgeCommand } from '../whatsapp/event-handlers.js';

export const pendingGcCodes = new Map<string, { code: string; expires: number }>();
// Short key store for gcset callbacks (avoids 64-byte Telegram limit)
// key: "sessionId:shortKey" -> gcJid
const gcJidStore = new Map<string, string>();
// Invite link cache: "sessionId:gcJid" -> { link, fetchedAt }
const inviteLinkCache = new Map<string, { link: string; fetchedAt: number }>();
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
    awaitingApproveAmountSessionId?: string;
    awaitingApproveAmountGcJid?: string;
    awaitingApproveCountrySessionId?: string;
    awaitingApproveCountryGcJid?: string;
    awaitingPromoteSessionId?: string;
    awaitingPromoteGcJid?: string;
    awaitingDemoteSessionId?: string;
    awaitingDemoteGcJid?: string;
    awaitingGcSetSessionId?: string;
    awaitingGcSetField?: string;
    awaitingGcSetJid?: string;
    awaitingLeaveGcSessionId?: string;
    // Per-group bridge mode
    groupBridgeSessionId?: string;
    groupBridgeGcJid?: string;
    groupBridgeGcName?: string;
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

// ── Bulk Operation Helpers ────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBulkProgressText(op: string, done: number, remaining: number, failed: number): string {
  return [
    `<b>${escape(op)}</b>`,
    `<code>------------------------------</code>`,
    `⏳ Running…`,
    ``,
    `✔ <b>${done}</b> Removed`,
    `⏳ <b>${remaining}</b> Remaining`,
    ...(failed > 0 ? [`❌ <b>${failed}</b> Failed`] : []),
  ].join('\n');
}

function buildBulkCompleteText(op: string, done: number, failed: number): string {
  return [
    `<b>${escape(op)}</b>`,
    `<code>------------------------------</code>`,
    `✔ <b>${done}</b> Removed`,
    ...(failed > 0 ? [`❌ <b>${failed}</b> Failed`] : []),
    ``,
    `<i>Operation Complete.</i>`,
  ].join('\n');
}

function buildApproveProgressText(approved: number, remaining: number, failed: number): string {
  return [
    `<b>✅ Approve Requests</b>`,
    `<code>------------------------------</code>`,
    `⏳ Running…`,
    ``,
    `✔ <b>${approved}</b> Approved`,
    `⏳ <b>${remaining}</b> Remaining`,
    ...(failed > 0 ? [`❌ <b>${failed}</b> Failed`] : []),
  ].join('\n');
}

// ── Bot Factory ───────────────────────────────────────────

// ── Create Group Helper ───────────────────────────────────
async function doCreateGroup(
  ctx: import('telegraf').Context & { chat: NonNullable<import('telegraf').Context['chat']> },
  socket: import('../whatsapp/baileys-types.js').BridgeWASocket | null,
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
              [copyBtn('📋 Copy Invite Link', inviteLink, 'primary')],
              [copyBtn('📋 Copy Admin Code', joinCode, 'primary')],
              [btn('⚙️ Group Settings', `gcset:${sessionId}:${storeGcJid(sessionId, groupJid)}`, 'primary')],
              [btn('🔙 Back', `session:${sessionId}:menu`, 'primary')],
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
          groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string; addedBy?: string; phoneNumber?: string; phone_number?: string }>>;
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
          const pending = await sock.groupRequestParticipantsList(gcJid).catch((): Array<{ jid: string; addedBy?: string; phoneNumber?: string; phone_number?: string }> => []);
          const pendingMatch = pending.find((r) => {
            // Prefer phone number field (both camelCase and raw snake_case attrs from Baileys)
            const phoneRaw = (r.phone_number ?? r.phoneNumber ?? '').replace(/[^0-9]/g, '');
            if (phoneRaw) return phoneRaw === digits || phoneRaw.endsWith(digits) || digits.endsWith(phoneRaw);
            // For @s.whatsapp.net JIDs the local part IS the phone number
            if (!r.jid.endsWith('@lid')) {
              const rNum = (r.jid.split('@')[0] ?? '').split(':')[0];
              return rNum === digits;
            }
            return false;
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
        const member = meta.participants.find((p) => { const pNum = (p.id.split('@')[0]??'').split(':')[0]; const pPhone = (p as unknown as {phoneNumber?:string}).phoneNumber?.replace(/[^0-9]/g,'') || ''; return pNum === digits || pPhone === digits; });
        if (!member) throw new Error(`+${digits} is not in the group`);
        if (!member.admin) throw new Error(`+${digits} is not an admin`);
        await sock.groupParticipantsUpdate(gcJid, [member.id], 'demote');
        await ctx.reply(noticeCard('Demoted', `+${digits} is no longer an admin.`, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      } catch (error) {
        await ctx.reply(noticeCard('Demote Failed', String(error), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) });
      }
      return;
    }

    // ── Approve by Amount ─────────────────────────────────
    if (ctx.session?.awaitingApproveAmountSessionId && ctx.session?.awaitingApproveAmountGcJid) {
      const sessionId = ctx.session.awaitingApproveAmountSessionId;
      const gcJid = ctx.session.awaitingApproveAmountGcJid;
      delete ctx.session.awaitingApproveAmountSessionId;
      delete ctx.session.awaitingApproveAmountGcJid;
      const gcKey = storeGcJid(sessionId, gcJid);
      const amount = parseInt(text.trim(), 10);
      if (isNaN(amount) || amount < 1) {
        await ctx.reply(noticeCard('Invalid Amount', 'Please enter a positive number.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) });
        return;
      }
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) { await ctx.reply(noticeCard('Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML' }); return; }
      const sock2 = socket as unknown as {
        groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string }>>;
        groupRequestParticipantsUpdate(jid: string, participants: string[], action: 'approve' | 'reject'): Promise<unknown>;
      };
      let pending: Array<{ jid: string }> = [];
      try { pending = await sock2.groupRequestParticipantsList(gcJid); } catch (err) {
        await ctx.reply(noticeCard('Failed', String(err), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) });
        return;
      }
      const toApprove = pending.slice(0, amount);
      if (toApprove.length === 0) {
        await ctx.reply(noticeCard('No Pending Requests', 'There are currently no pending join requests.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) });
        return;
      }
      const progressMsg = await ctx.reply(buildApproveProgressText(0, toApprove.length, 0), { parse_mode: 'HTML' });
      let approved = 0, failed = 0;
      const BATCH = 10;
      for (let i = 0; i < toApprove.length; i += BATCH) {
        const batch = toApprove.slice(i, i + BATCH).map((r) => r.jid);
        try {
          await sock2.groupRequestParticipantsUpdate(gcJid, batch, 'approve');
          approved += batch.length;
        } catch {
          for (const jid of batch) {
            try { await sock2.groupRequestParticipantsUpdate(gcJid, [jid], 'approve'); approved++; }
            catch { failed++; }
          }
        }
        await ctx.telegram.editMessageText(ctx.chat!.id, progressMsg.message_id, undefined, buildApproveProgressText(approved, toApprove.length - approved - failed, failed), { parse_mode: 'HTML' }).catch(() => {});
        if (i + BATCH < toApprove.length) await sleep(800);
      }
      const remaining = pending.length - toApprove.length;
      await ctx.telegram.editMessageText(ctx.chat!.id, progressMsg.message_id, undefined, [
        `<b>✅ Approve by Amount — Complete</b>`,
        `<code>------------------------------</code>`,
        `<b>Requested:</b> ${amount}`,
        ``,
        `<b>Approved:</b>\n✔ ${approved}`,
        ...(failed > 0 ? [`<b>Failed:</b> ${failed}`] : []),
        `<b>Remaining:</b> ${remaining}`,
      ].join('\n'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
      return;
    }

    // ── Approve by Country ────────────────────────────────
    if (ctx.session?.awaitingApproveCountrySessionId && ctx.session?.awaitingApproveCountryGcJid) {
      const sessionId = ctx.session.awaitingApproveCountrySessionId;
      const gcJid = ctx.session.awaitingApproveCountryGcJid;
      delete ctx.session.awaitingApproveCountrySessionId;
      delete ctx.session.awaitingApproveCountryGcJid;
      const gcKey = storeGcJid(sessionId, gcJid);
      // Normalize country code: strip + and non-digits, keep digits
      const rawInput = text.trim();
      const countryDigits = rawInput.replace(/[^0-9]/g, '');
      if (!countryDigits) {
        await ctx.reply(noticeCard('Invalid Country Code', 'Enter a code like +234, +1, or +44.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) });
        return;
      }
      const socket = getSocket(sessionId);
      if (!socket || isFrozen(sessionId)) { await ctx.reply(noticeCard('Failed', 'Session not connected.', 'warning'), { parse_mode: 'HTML' }); return; }
      const sock2 = socket as unknown as {
        groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string; phoneNumber?: string; phone_number?: string }>>;
        groupRequestParticipantsUpdate(jid: string, participants: string[], action: 'approve' | 'reject'): Promise<unknown>;
      };
      let pending: Array<{ jid: string; phoneNumber?: string; phone_number?: string }> = [];
      try { pending = await sock2.groupRequestParticipantsList(gcJid); } catch (err) {
        await ctx.reply(noticeCard('Failed', String(err), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) });
        return;
      }
      const matched = pending.filter((r) => {
        // Baileys returns raw XML attrs — key may be snake_case phone_number OR camelCase phoneNumber.
        const phoneRaw = (r.phone_number ?? r.phoneNumber ?? '').replace(/[^0-9]/g, '');
        if (phoneRaw) return phoneRaw.startsWith(countryDigits);
        // For @s.whatsapp.net JIDs the local part IS the E.164 number — safe to match.
        if (!r.jid.endsWith('@lid')) {
          const jidNum = (r.jid.split('@')[0] ?? '').split(':')[0]!;
          return jidNum.startsWith(countryDigits);
        }
        // @lid JID with no phone number — country is unresolvable; include in the
        // batch so LID-format Nigerian requesters are not silently skipped.
        return true;
      });
      if (matched.length === 0) {
        await ctx.reply(noticeCard('No Matches', `No pending requests found with country code +${countryDigits}.`, 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) });
        return;
      }
      const progressMsg = await ctx.reply(buildApproveProgressText(0, matched.length, 0), { parse_mode: 'HTML' });
      let approved = 0, failed = 0;
      const BATCH = 10;
      for (let i = 0; i < matched.length; i += BATCH) {
        const batch = matched.slice(i, i + BATCH).map((r) => r.jid);
        try {
          await sock2.groupRequestParticipantsUpdate(gcJid, batch, 'approve');
          approved += batch.length;
        } catch {
          for (const jid of batch) {
            try { await sock2.groupRequestParticipantsUpdate(gcJid, [jid], 'approve'); approved++; }
            catch { failed++; }
          }
        }
        await ctx.telegram.editMessageText(ctx.chat!.id, progressMsg.message_id, undefined, buildApproveProgressText(approved, matched.length - approved - failed, failed), { parse_mode: 'HTML' }).catch(() => {});
        if (i + BATCH < matched.length) await sleep(800);
      }
      const remaining = pending.length - matched.length;
      await ctx.telegram.editMessageText(ctx.chat!.id, progressMsg.message_id, undefined, [
        `<b>✅ Approve by Country — Complete</b>`,
        `<code>------------------------------</code>`,
        `<b>Country:</b> +${countryDigits}`,
        ``,
        `<b>Found:</b> ${matched.length} Requests`,
        `<b>Approved:</b>\n✔ ${approved}`,
        ...(failed > 0 ? [`<b>Failed:</b> ${failed}`] : []),
        `<b>Remaining:</b> ${remaining}`,
      ].join('\n'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
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

    // ── Group Bridge Mode (per-group) ────────────────────
    const groupBridge = getGroupBridge(ctx.telegramId);
    if (groupBridge ?? (ctx.session?.groupBridgeSessionId && ctx.session?.groupBridgeGcJid)) {
      const { sessionId: gbSessionId, gcJid: gbGcJid, gcName: gbGcName } = groupBridge ?? {
        sessionId: ctx.session.groupBridgeSessionId!,
        gcJid: ctx.session.groupBridgeGcJid!,
        gcName: ctx.session.groupBridgeGcName ?? '',
      };
      const socket = getSocket(gbSessionId);
      if (!socket || isFrozen(gbSessionId)) {
        await ctx.reply(
          noticeCard('Group Bridge Unavailable', 'Session disconnected or frozen. Use Exit Group Bridge to leave bridge mode.', 'warning'),
          { parse_mode: 'HTML' }
        );
        return;
      }

      try {
        await executeGroupBridgeCommand(
          gbSessionId,
          ctx.telegramId,
          text,
          gbGcJid,
          socket,
          async (response) => {
            if (response) await ctx.reply(response);
          }
        );
      } catch (error) {
        logger.error('[Bot] Group bridge command failed', { gbSessionId, error: String(error) });
        await ctx.reply(
          noticeCard('Group Bridge Error', 'The command could not be completed in the bridged group.', 'error', String(error)),
          { parse_mode: 'HTML' }
        );
      }
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
      const entries = raw.split(/[\n,]+/u).map((entry) => entry.includes('|') ? entry.split('|').slice(1).join('|').trim() : entry.trim()).filter(Boolean);
      const allUrls = entries.length > 0 && entries.every((entry) => /^https?:\/\//i.test(entry));
      const isJid = raw.includes('@g.us') || raw.includes('@newsletter') || raw.includes('@s.whatsapp.net');
      if (!allUrls && !isJid) {
        await ctx.reply(
          noticeCard('Invalid Input', 'Send one or more URL buttons as Label|https://... lines, or "clear" to remove.', 'error'),
          { parse_mode: 'HTML' }
        );
        return;
      }
      setGlobalMenuUrl(raw);
      await ctx.reply(
        card('Global Menu URL Saved', '\U0001f517', [['Value', raw]], 'Will appear as native URL button(s) on supported WhatsApp bot responses.'),
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
      // gcset handles its own answerCbQuery with show_alert for feedback
      if (action !== 'gcset') await ctx.answerCbQuery().catch(() => {});
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
    const sub = params[0];

    if (sub === 'stickers') {
      await ctx.editMessageText(
        `${header('Sticker Macro Help', '🎭')}\n\nUnbound stickers stay silent. Reply directly to the sticker with ${H.code('.setcmd [command]')} to bind it.`,
        { parse_mode: 'HTML', reply_markup: backKeyboard('settings:macros') }
      );
      return;
    }

    if (sub === 'cat') {
      const cat = params[1] ?? '';
      const cfg = loadConfig(ctx.telegramId);
      const p = escape(cfg.prefix || '.');
      type CmdRow = [string, string];
      const categories: Record<string, { title: string; emoji: string; rows: CmdRow[] }> = {
        groupmod: {
          title: 'Group Moderation', emoji: '🛡',
          rows: [
            [`${p}kick`, 'Kick — reply / @mention / number'],
            [`${p}ban / ${p}unban`, 'Ban or unban a member'],
            [`${p}banlist`, 'View ban list for this group'],
            [`${p}promote / ${p}demote`, 'Grant or remove admin status'],
            [`${p}warn / ${p}unwarn`, 'Issue or clear a warning'],
            [`${p}warns`, 'Check warning count'],
            [`${p}poll Q|A|B`, 'Create a group poll'],
            [`${p}welcome / ${p}goodbye`, 'Welcome & goodbye messages'],
            [`${p}kickmsg / ${p}warnmsg / ${p}banmsg`, 'Customise action responses'],
            [`${p}eventstatus`, 'Group event config overview'],
            [`${p}userinfo`, 'Show user JID, number & LID'],
          ] as CmdRow[],
        },
        antisystem: {
          title: 'Anti System', emoji: '🚨',
          rows: [
            [`${p}antistatus`, 'Overview of all anti modules'],
            [`${p}antilink <kick|warn|delete>`, 'Block links'],
            [`${p}antibot`, 'Remove automation clients'],
            [`${p}antispam`, 'Rate-limit spammers'],
            [`${p}spamlimit <n> <sec>`, 'Adjust spam window'],
            [`${p}antipic / ${p}antivid / ${p}antiaud`, 'Block media types'],
            [`${p}antivn / ${p}antitxt`, 'Block voice notes / plain text'],
            [`${p}antiemoji / ${p}antisticker`, 'Block emoji / stickers'],
            [`${p}antigroupcall`, 'Block group calls'],
            [`${p}antinsfw`, 'NSFW detection (needs ANTI_NSFW_API_URL)'],
            [`${p}antigroupmention`, 'Block @group / channel mentions'],
            [`${p}antiwords`, 'Block custom word list'],
            [`${p}antiaddword / ${p}antirmword`, 'Add / remove blocked words'],
            [`${p}antiwordlist`, 'Show blocked word list'],
            [`${p}antipoll / ${p}antiforward`, 'Block polls / forwards'],
            [`${p}antichannel`, 'Block channel reposts'],
            [`${p}antipromote / ${p}antidemote <mode>`, 'Guard admin changes'],
            [`${p}<module>permit / ${p}rm<module>permit`, 'Exempt / un-exempt a user'],
            [`${p}<module>msg <text>`, 'Custom violation response'],
          ] as CmdRow[],
        },
        status: {
          title: 'Status Engine', emoji: '📡',
          rows: [
            [`${p}godcast / ${p}statusdesign`, 'Designed status for current GC'],
            [`${p}settheme <theme>`, 'Set status design theme'],
            [`${p}smedia`, 'Post media status'],
            [`${p}gstatus <msg>`, 'Post to current group status'],
            [`${p}tochat <jid> <msg>`, 'Send message to a target group'],
            [`${p}togstatus <jid> <msg>`, 'Post to a target group status'],
            [`${p}tochatx <jid> <n> <msg>`, 'Repeat send to a target chat'],
            [`${p}togstatusx <n> <jid> <msg>`, 'Repeat group status post'],
            [`${p}sstatus <msg>`, 'Run status loop until stopspam'],
            [`${p}stopspam`, 'Stop the active status loop'],
          ] as CmdRow[],
        },
        broadcast: {
          title: 'Broadcast Network', emoji: '📣',
          rows: [
            [`${p}allstatus <msg>`, 'Post to all group statuses'],
            [`${p}allstatusx <n> <msg>`, 'Repeat allstatus n times'],
            [`${p}allchat <msg>`, 'Send to all groups with hidetag'],
            [`${p}stopspam`, 'Cancel any active broadcast'],
          ] as CmdRow[],
        },
        lifecycle: {
          title: 'Lifecycle Module', emoji: '🔗',
          rows: [
            [`${p}join <link>`, 'Join a group via invite link'],
            [`${p}joinall`, 'Join all active bucket links'],
            [`${p}left`, 'Leave the current group'],
            [`${p}leave <jid/link>`, 'Leave a specific group'],
            [`${p}leaveall`, 'Leave all joined groups'],
            [`${p}tag`, 'Hidetag all group members'],
            [`${p}mtag`, 'Visible mention all members'],
            [`${p}pair <phone>`, 'Pair a new WA number from WhatsApp'],
          ] as CmdRow[],
        },
        settings: {
          title: 'System & Config', emoji: '⚙️',
          rows: [
            [`${p}setprefix <p>`, 'Change command prefix'],
            [`${p}setcmd <cmd>`, 'Bind quoted sticker to a command'],
            [`${p}delcmd`, 'Remove a sticker binding'],
            [`${p}setsudo <number>`, 'Grant command access'],
            [`${p}delsudo <number>`, 'Revoke command access'],
            [`${p}sudo`, 'List sudo numbers'],
            [`${p}info`, 'Session status information'],
            [`${p}groups`, 'List all joined groups'],
            [`${p}jid <link>`, 'Resolve a group invite to JID'],
            [`${p}ping`, 'Measure connection latency'],
          ] as CmdRow[],
        },
      };

      const entry = categories[cat];
      if (!entry) {
        await ctx.answerCbQuery('Unknown category').catch(() => {});
        return;
      }

      const lines = entry.rows.map(([cmd, desc]) => `${H.code(cmd)} — ${escape(desc)}`).join('\n');
      await ctx.editMessageText(
        `${header(entry.title, entry.emoji)}\n\n${lines}`,
        { parse_mode: 'HTML', reply_markup: helpCategoryKeyboard() }
      );
      return;
    }

    // Default: help:main
    await ctx.editMessageText(helpText(ctx.isOwner), {
      parse_mode: 'HTML',
      reply_markup: helpKeyboard(),
    });
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
    if (sub === 'info') {
      const ownerId = sessionOwner(ctx, sessionId);
      const meta = loadSessionMeta(ownerId, sessionId);
      if (!meta) { await ctx.answerCbQuery('Session not found', { show_alert: true }).catch(() => {}); return; }
      const socket = getSocket(sessionId);
      let waName = '';
      let waBio = '';
      // Fast profile fetch — no groupFetchAllParticipating
      if (socket) {
        try {
          const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
          const statusList = await (socket as unknown as { fetchStatus(...j: string[]): Promise<Array<{status?: string}>|null> }).fetchStatus(ownJid).catch(() => null);
          waBio = Array.isArray(statusList) ? (statusList[0]?.status ?? '') : '';
          const contacts = (socket as unknown as { store?: { contacts?: Record<string, { name?: string; notify?: string }> } }).store?.contacts;
          const c = contacts?.[ownJid];
          waName = c?.name ?? c?.notify ?? '';
        } catch { /* ignore */ }
      }
      const statusEmoji = { open: '🟢', connecting: '🟡', frozen: '🔵', error: '🔴', banned: '💀', closed: '⚫' }[meta.status] ?? '⚪';
      const text = [
        `${statusEmoji} <b>Session Info</b>`,
        `<code>------------------------------</code>`,
        `🏷️ <b>Label:</b> ${escape(meta.label || meta.phone)}`,
        `📱 <b>Number:</b> <code>${escape(meta.phone)}</code>`,
        waName ? `👤 <b>WA Name:</b> ${escape(waName)}` : '',
        waBio ? `📝 <b>Bio:</b> ${escape(waBio)}` : '',
        `📊 <b>Status:</b> ${statusEmoji} ${meta.status.toUpperCase()}`,
        `🔗 <b>Paired:</b> ${meta.status === 'open' ? '✅ Yes' : '❌ No'}`,
        meta.pairedAt ? `⏰ <b>Since:</b> ${new Date(meta.pairedAt).toLocaleString()}` : '',
        ``,
        `<blockquote expandable>🔑 Session ID\n<code>${escape(sessionId)}</code></blockquote>`,
      ].filter(Boolean).join('\n');
      const { sessionMenuKeyboard: smk } = await import('./ui/keyboards.js');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: smk(sessionId) }).catch(() => {});
      return;
    }
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
      const nav: ReturnType<typeof btn>[] = [];
      if (page > 0) nav.push(btn('◀ Prev', `session:${sessionId}:groups:${page - 1}`, 'primary'));
      if ((page + 1) * PAGE_SIZE < total) nav.push(btn('Next ▶', `session:${sessionId}:groups:${page + 1}`, 'primary'));
      const keyboard = {
        inline_keyboard: [
          ...(nav.length ? [nav] : []),
          [btn('🔙 Back', `session:${sessionId}:menu`, 'primary')],
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
      const nav: ReturnType<typeof btn>[] = [];
      if (page > 0) nav.push(btn('◀ Prev', `session:${sessionId}:mygroups:${page - 1}`, 'primary'));
      if ((page + 1) * PAGE < total) nav.push(btn('Next ▶', `session:${sessionId}:mygroups:${page + 1}`, 'primary'));
      const gcButtons = slice.map((g) => [btn((g as unknown as { subject: string }).subject, `gcset:${sessionId}:${storeGcJid(sessionId, g.id)}`, 'primary')]);
      await ctx.editMessageText(
        card('My Groups (Admin)', 'GC', [['Total', String(total)], ['Page', `${page + 1}/${Math.ceil(total / PAGE) || 1}`]], total ? 'Groups where this session is admin.' : 'Not admin in any group.'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              ...gcButtons,
              ...(nav.length ? [nav] : []),
              [btn('🔙 Back', `session:${sessionId}:menu`, 'primary')],
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
      groupMetadata(jid: string): Promise<{ subject: string; desc?: string; participants: { id: string; admin?: string | null; phoneNumber?: string }[]; creation?: number }>;
      groupSettingUpdate(jid: string, setting: string): Promise<void>;
      groupJoinApprovalMode(jid: string, mode: string): Promise<void>;
      groupMemberAddMode(jid: string, mode: string): Promise<void>;
      groupLeave(id: string): Promise<void>;
      groupParticipantsUpdate(jid: string, p: string[], action: string): Promise<unknown>;
      profilePictureUrl(jid: string, type: string): Promise<string | null>;
      groupInviteCode(jid: string): Promise<string>;
      groupRequestParticipantsList(jid: string): Promise<Array<{ jid: string; addedBy?: string; phoneNumber?: string; phone_number?: string }>>;
      groupRequestParticipantsUpdate(jid: string, participants: string[], action: 'approve' | 'reject'): Promise<unknown>;
      user?: { id?: string };
    };

    if (!sub2) {
      // Show group settings menu
      const meta = await sock.groupMetadata(gcJid).catch(() => null);
      if (!meta) { await ctx.answerCbQuery('Could not fetch group', { show_alert: true }).catch(() => {}); return; }
      const admins = meta.participants.filter((p) => p.admin).map((p) => { const phone = p.phoneNumber?.replace(/[^0-9]/g, '') || (p.id.split('@')[0] ?? '').split(':')[0]; return `+${phone}`; }).join(', ') || 'None';
      const metaFull = meta as unknown as { joinApprovalMode?: boolean; memberAddMode?: boolean };
      const joinApproval = metaFull.joinApprovalMode ? '🟢 ON' : '🔴 OFF';
      const memberAdd = metaFull.memberAddMode ? '🟢 All Members' : '🔴 Admins Only';
      // Fetch invite link (use cache if fresh < 10 min)
      const cacheKey = `${sessionId}:${gcJid}`;
      const cached = inviteLinkCache.get(cacheKey);
      let inviteLink: string | null = null;
      if (cached && Date.now() - cached.fetchedAt < 10 * 60_000) {
        inviteLink = cached.link;
      } else {
        try {
          const code = await sock.groupInviteCode(gcJid);
          inviteLink = `https://chat.whatsapp.com/${code}`;
          inviteLinkCache.set(cacheKey, { link: inviteLink, fetchedAt: Date.now() });
        } catch { /* no permission or error — show button to try */ }
      }
      const gcKey = storeGcJid(sessionId, gcJid);
      const text = [
        `<b>Group Dashboard</b>`,
        `<code>------------------------------</code>`,
        `<b>Name:</b> ${escape(meta.subject)}`,
        `<b>Members:</b> ${meta.participants.length}`,
        `<b>Admins:</b> ${escape(admins)}`,
        `<b>Join Approval:</b> ${joinApproval}`,
        `<b>Member Add:</b> ${memberAdd}`,
        inviteLink ? `<b>Invite Link:</b> <code>${escape(inviteLink)}</code>` : `<b>Invite Link:</b> —`,
        meta.desc ? `<b>Desc:</b> <blockquote expandable>${escape(meta.desc)}</blockquote>` : '',
        `<b>JID:</b> <code>${escape(gcJid)}</code>`,
      ].filter(Boolean).join('\n');
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [btn('🌉 Group Bridge', `gcbridge:${sessionId}:${gcKey}`, 'success')],
            [btn('✏️ Edit Name', `gcset:${sessionId}:${gcKey}:name`, 'primary'), btn('📝 Edit Desc', `gcset:${sessionId}:${gcKey}:desc`, 'primary')],
            [btn('🖼 Set PFP', `gcset:${sessionId}:${gcKey}:pfp`, 'primary'), btn('📸 Get PFP', `gcset:${sessionId}:${gcKey}:getpfp`, 'primary')],
            [btn('⬆️ Promote Admin', `gcset:${sessionId}:${gcKey}:promote`, 'success'), btn('⬇️ Demote Admin', `gcset:${sessionId}:${gcKey}:demote`, 'danger')],
            [btn('✅ Join Approval ON', `gcset:${sessionId}:${gcKey}:approval:on`, 'success'), btn('🔴 Join Approval OFF', `gcset:${sessionId}:${gcKey}:approval:off`, 'danger')],
            [btn('✅ Members Add ON', `gcset:${sessionId}:${gcKey}:memberadd:on`, 'success'), btn('🔴 Members Add OFF', `gcset:${sessionId}:${gcKey}:memberadd:off`, 'danger')],
            [btn('📎 Invite Link', `gcset:${sessionId}:${gcKey}:invitelink`, 'primary'), btn('🚫 Block All', `gcset:${sessionId}:${gcKey}:blockall`, 'danger')],
            [btn('🦵 Kick All Members', `gcset:${sessionId}:${gcKey}:kickall`, 'danger'), btn('🦵 Kick All Admins', `gcset:${sessionId}:${gcKey}:kickadmins`, 'danger')],
            [btn('⬇️ Demote All Admins', `gcset:${sessionId}:${gcKey}:demoteall`, 'danger'), btn('✅ Approve Requests', `gcset:${sessionId}:${gcKey}:approverequests`, 'success')],
            [btn('🚪 Leave Group', `gcset:${sessionId}:${gcKey}:leave`, 'danger')],
            [btn('🔙 Back', `session:${sessionId}:mygroups`, 'primary')],
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
        await ctx.answerCbQuery(`✅ Join Approval ${mode === 'on' ? 'ON' : 'OFF'}`, { show_alert: true }).catch(() => {});
        await ctx.editMessageText(
          noticeCard(`Join Approval ${mode === 'on' ? 'Enabled' : 'Disabled'}`, mode === 'on' ? 'New members must be approved before joining.' : 'Anyone with the link can join freely.', 'success'),
          { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) }
        ).catch(() => {});
      } catch (err) {
        await ctx.answerCbQuery(`Failed: ${String(err).slice(0, 50)}`, { show_alert: true }).catch(() => {});
      }
      return;
    }
    if (sub2 === 'memberadd') {
      const label = params[3] === 'on' ? 'All Members Can Add' : 'Admins Only Can Add';
      const mode = params[3] === 'on' ? 'all_member_add' : 'admin_add';
      try {
        await sock.groupMemberAddMode(gcJid, mode);
        await ctx.answerCbQuery(`✅ ${label}`, { show_alert: true }).catch(() => {});
        await ctx.editMessageText(
          noticeCard('Member Add Mode Updated', label, 'success'),
          { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${storeGcJid(sessionId, gcJid)}`) }
        ).catch(() => {});
      } catch (err) {
        await ctx.answerCbQuery(`Failed: ${String(err).slice(0, 50)}`, { show_alert: true }).catch(() => {});
      }
      return;
    }
    if (sub2 === 'leave') {
      await sock.groupLeave(gcJid);
      await ctx.editMessageText(noticeCard('Left Group', gcJid, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`session:${sessionId}:mygroups`) }).catch(() => {});
      return;
    }

    // ── Invite Link ───────────────────────────────────────────
    if (sub2 === 'invitelink') {
      const gcKey = storeGcJid(sessionId, gcJid);
      try {
        const cacheKey = `${sessionId}:${gcJid}`;
        let inviteLink: string;
        const cached = inviteLinkCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < 10 * 60_000) {
          inviteLink = cached.link;
        } else {
          const code = await sock.groupInviteCode(gcJid);
          inviteLink = `https://chat.whatsapp.com/${code}`;
          inviteLinkCache.set(cacheKey, { link: inviteLink, fetchedAt: Date.now() });
        }
        await ctx.editMessageText(
          [
            `<b>📎 Group Invite Link</b>`,
            `<code>------------------------------</code>`,
            `<code>${escape(inviteLink)}</code>`,
          ].join('\n'),
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [copyBtn('📋 Copy Link', inviteLink, 'primary')],
                [btn('🔙 Back', `gcset:${sessionId}:${gcKey}`, 'primary')],
              ],
            },
          }
        ).catch(() => {});
      } catch (err) {
        await ctx.answerCbQuery(`Failed: ${String(err).slice(0, 60)}`, { show_alert: true }).catch(() => {});
      }
      return;
    }

    // sub3 must be declared before all bulk-operation routing so each branch can guard on it
    const sub3 = params[3];

    // ── Block All — invoke the same WhatsApp command implementation ─────
    if (sub2 === 'blockall' && !sub3) {
      const gcKey = storeGcJid(sessionId, gcJid);
      const meta = await sock.groupMetadata(gcJid).catch(() => null);
      if (!meta) { await ctx.answerCbQuery('Could not fetch group', { show_alert: true }).catch(() => {}); return; }
      const eligible = meta.participants.filter((p) => !p.admin).length;
      await ctx.editMessageText(
        [
          `<b>⚠️ Block All</b>`,
          `<code>------------------------------</code>`,
          `<b>Eligible regular members:</b> ${eligible}`,
          ``,
          `This runs the WhatsApp <code>blockall</code> command for only this session and this group.`,
          `<b>This action cannot be undone.</b> Continue?`,
        ].join('\n'),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[btn('✅ Yes, Block All', `gcset:${sessionId}:${gcKey}:blockall:run`, 'danger'), btn('❌ Cancel', `gcset:${sessionId}:${gcKey}`, 'primary')]] } }
      ).catch(() => {});
      return;
    }

    if (sub2 === 'blockall' && sub3 === 'run') {
      const gcKey = storeGcJid(sessionId, gcJid);
      let progressMessageId: number | null = null;
      const first = await ctx.editMessageText(buildBulkProgressText('Block All', 0, 0, 0), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }).catch(() => null);
      if (first) progressMessageId = (first as unknown as { message_id?: number }).message_id ?? null;
      const update = async (text: string): Promise<void> => {
        if (progressMessageId) await ctx.telegram.editMessageText(ctx.chat!.id, progressMessageId, undefined, text, { parse_mode: 'HTML' }).catch(() => {});
      };
      const result = await cmdBlockAll(socket, ctx.telegramId, sessionId, gcJid, loadSessionConfig(ctx.telegramId, sessionId).sudoNumbers ?? [], update);
      if (progressMessageId) {
        await ctx.telegram.editMessageText(ctx.chat!.id, progressMessageId, undefined, result, { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
      } else {
        await ctx.reply(result, { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) });
      }
      return;
    }

    // ── Kick All Members — Confirm ────────────────────────────
    if (sub2 === 'kickall' && !sub3) {
      const gcKey = storeGcJid(sessionId, gcJid);
      const meta = await sock.groupMetadata(gcJid).catch(() => null);
      if (!meta) { await ctx.answerCbQuery('Could not fetch group', { show_alert: true }).catch(() => {}); return; }
      const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
      const selfNum = ownJid.split('@')[0]?.split(':')[0] ?? '';
      const toKick = meta.participants.filter((p) => {
        if (p.admin) return false;
        const pNum = (p.id.split('@')[0] ?? '').split(':')[0];
        return pNum !== selfNum && p.id !== ownJid && !p.id.startsWith(selfNum + '@') && !p.id.startsWith(selfNum + ':');
      });
      await ctx.editMessageText(
        [
          `<b>⚠️ Kick All Members</b>`,
          `<code>------------------------------</code>`,
          `<b>Eligible to kick:</b> ${toKick.length} members`,
          ``,
          `This will remove every non-admin member from the group. Admins and the bot are protected.`,
          ``,
          `<b>This action cannot be undone.</b> Continue?`,
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [btn('✅ Yes, Kick All', `gcset:${sessionId}:${gcKey}:kickall:run`, 'danger'), btn('❌ Cancel', `gcset:${sessionId}:${gcKey}`, 'primary')],
            ],
          },
        }
      ).catch(() => {});
      return;
    }

    if (sub2 === 'kickall' && sub3 === 'run') {
      const gcKey = storeGcJid(sessionId, gcJid);
      const meta = await sock.groupMetadata(gcJid).catch(() => null);
      if (!meta) { await ctx.answerCbQuery('Could not fetch group', { show_alert: true }).catch(() => {}); return; }
      const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
      const selfNum = ownJid.split('@')[0]?.split(':')[0] ?? '';
      const toKick = meta.participants.filter((p) => {
        if (p.admin) return false;
        const pNum = (p.id.split('@')[0] ?? '').split(':')[0];
        return pNum !== selfNum && p.id !== ownJid && !p.id.startsWith(selfNum + '@') && !p.id.startsWith(selfNum + ':');
      });
      if (toKick.length === 0) {
        await ctx.editMessageText(noticeCard('No Members to Kick', 'There are no non-admin members to remove.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
        return;
      }
      const progressMsg = await ctx.editMessageText(
        buildBulkProgressText('Kick All Members', 0, toKick.length, 0),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      ).catch(() => null);
      let removed = 0, failed = 0;
      const BATCH = 5;
      for (let i = 0; i < toKick.length; i += BATCH) {
        const batch = toKick.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(async (p) => {
          try {
            await sock.groupParticipantsUpdate(gcJid, [p.id], 'remove');
            removed++;
          } catch { failed++; }
        }));
        const progressText = buildBulkProgressText('Kick All Members', removed, toKick.length - removed - failed, failed);
        if (progressMsg) {
          await ctx.telegram.editMessageText(ctx.chat!.id, (progressMsg as unknown as { message_id: number }).message_id, undefined, progressText, { parse_mode: 'HTML' }).catch(() => {});
        }
        if (i + BATCH < toKick.length) await sleep(1200);
      }
      const finalText = buildBulkCompleteText('Kick All Members', removed, failed);
      if (progressMsg) {
        await ctx.telegram.editMessageText(ctx.chat!.id, (progressMsg as unknown as { message_id: number }).message_id, undefined, finalText, { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
      }
      return;
    }

    // ── Kick All Admins — Confirm ──────────────────────────────
    if (sub2 === 'kickadmins' && !sub3) {
      const gcKey = storeGcJid(sessionId, gcJid);
      const meta = await sock.groupMetadata(gcJid).catch(() => null);
      if (!meta) { await ctx.answerCbQuery('Could not fetch group', { show_alert: true }).catch(() => {}); return; }
      const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
      const selfNum = ownJid.split('@')[0]?.split(':')[0] ?? '';
      const toKick = meta.participants.filter((p) => {
        if (p.admin !== 'admin') return false; // skip superadmin (group owner)
        const pNum = (p.id.split('@')[0] ?? '').split(':')[0];
        return pNum !== selfNum && p.id !== ownJid && !p.id.startsWith(selfNum + '@') && !p.id.startsWith(selfNum + ':');
      });
      await ctx.editMessageText(
        [
          `<b>⚠️ Kick All Admins</b>`,
          `<code>------------------------------</code>`,
          `<b>Eligible to kick:</b> ${toKick.length} admins`,
          ``,
          `This removes every removable admin. The group owner and this bot are protected.`,
          ``,
          `<b>This action cannot be undone.</b> Continue?`,
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [btn('✅ Yes, Kick All Admins', `gcset:${sessionId}:${gcKey}:kickadmins:run`, 'danger'), btn('❌ Cancel', `gcset:${sessionId}:${gcKey}`, 'primary')],
            ],
          },
        }
      ).catch(() => {});
      return;
    }

    if (sub2 === 'kickadmins' && sub3 === 'run') {
      const gcKey = storeGcJid(sessionId, gcJid);
      const meta = await sock.groupMetadata(gcJid).catch(() => null);
      if (!meta) { await ctx.answerCbQuery('Could not fetch group', { show_alert: true }).catch(() => {}); return; }
      const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
      const selfNum = ownJid.split('@')[0]?.split(':')[0] ?? '';
      const toKick = meta.participants.filter((p) => {
        if (p.admin !== 'admin') return false;
        const pNum = (p.id.split('@')[0] ?? '').split(':')[0];
        return pNum !== selfNum && p.id !== ownJid && !p.id.startsWith(selfNum + '@') && !p.id.startsWith(selfNum + ':');
      });
      if (toKick.length === 0) {
        await ctx.editMessageText(noticeCard('No Admins to Kick', 'No removable admins found (owner and bot are protected).', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
        return;
      }
      const progressMsg = await ctx.editMessageText(
        buildBulkProgressText('Kick All Admins', 0, toKick.length, 0),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      ).catch(() => null);
      let removed = 0, failed = 0;
      const BATCH = 5;
      for (let i = 0; i < toKick.length; i += BATCH) {
        const batch = toKick.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(async (p) => {
          try {
            await sock.groupParticipantsUpdate(gcJid, [p.id], 'remove');
            removed++;
          } catch { failed++; }
        }));
        if (progressMsg) {
          await ctx.telegram.editMessageText(ctx.chat!.id, (progressMsg as unknown as { message_id: number }).message_id, undefined, buildBulkProgressText('Kick All Admins', removed, toKick.length - removed - failed, failed), { parse_mode: 'HTML' }).catch(() => {});
        }
        if (i + BATCH < toKick.length) await sleep(1200);
      }
      if (progressMsg) {
        await ctx.telegram.editMessageText(ctx.chat!.id, (progressMsg as unknown as { message_id: number }).message_id, undefined, buildBulkCompleteText('Kick All Admins', removed, failed), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
      }
      return;
    }

    // ── Demote All Admins — Confirm ────────────────────────────
    if (sub2 === 'demoteall' && !sub3) {
      const gcKey = storeGcJid(sessionId, gcJid);
      const meta = await sock.groupMetadata(gcJid).catch(() => null);
      if (!meta) { await ctx.answerCbQuery('Could not fetch group', { show_alert: true }).catch(() => {}); return; }
      const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
      const selfNum = ownJid.split('@')[0]?.split(':')[0] ?? '';
      const toDemote = meta.participants.filter((p) => {
        if (p.admin !== 'admin') return false;
        const pNum = (p.id.split('@')[0] ?? '').split(':')[0];
        return pNum !== selfNum && p.id !== ownJid && !p.id.startsWith(selfNum + '@') && !p.id.startsWith(selfNum + ':');
      });
      await ctx.editMessageText(
        [
          `<b>⚠️ Demote All Admins</b>`,
          `<code>------------------------------</code>`,
          `<b>Eligible to demote:</b> ${toDemote.length} admins`,
          ``,
          `This removes admin privileges from every removable admin. The group owner and this bot are protected.`,
          ``,
          `Continue?`,
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [btn('✅ Yes, Demote All', `gcset:${sessionId}:${gcKey}:demoteall:run`, 'danger'), btn('❌ Cancel', `gcset:${sessionId}:${gcKey}`, 'primary')],
            ],
          },
        }
      ).catch(() => {});
      return;
    }

    if (sub2 === 'demoteall' && sub3 === 'run') {
      const gcKey = storeGcJid(sessionId, gcJid);
      const meta = await sock.groupMetadata(gcJid).catch(() => null);
      if (!meta) { await ctx.answerCbQuery('Could not fetch group', { show_alert: true }).catch(() => {}); return; }
      const ownJid = (socket as unknown as { user?: { id?: string } }).user?.id ?? '';
      const selfNum = ownJid.split('@')[0]?.split(':')[0] ?? '';
      const toDemote = meta.participants.filter((p) => {
        if (p.admin !== 'admin') return false;
        const pNum = (p.id.split('@')[0] ?? '').split(':')[0];
        return pNum !== selfNum && p.id !== ownJid && !p.id.startsWith(selfNum + '@') && !p.id.startsWith(selfNum + ':');
      });
      if (toDemote.length === 0) {
        await ctx.editMessageText(noticeCard('No Admins to Demote', 'No removable admins found (owner and bot are protected).', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
        return;
      }
      const progressMsg = await ctx.editMessageText(
        buildBulkProgressText('Demote All Admins', 0, toDemote.length, 0),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      ).catch(() => null);
      let demoted = 0, failed = 0;
      const BATCH = 5;
      for (let i = 0; i < toDemote.length; i += BATCH) {
        const batch = toDemote.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(async (p) => {
          try {
            await sock.groupParticipantsUpdate(gcJid, [p.id], 'demote');
            demoted++;
          } catch { failed++; }
        }));
        if (progressMsg) {
          await ctx.telegram.editMessageText(ctx.chat!.id, (progressMsg as unknown as { message_id: number }).message_id, undefined, buildBulkProgressText('Demote All Admins', demoted, toDemote.length - demoted - failed, failed), { parse_mode: 'HTML' }).catch(() => {});
        }
        if (i + BATCH < toDemote.length) await sleep(1200);
      }
      if (progressMsg) {
        await ctx.telegram.editMessageText(ctx.chat!.id, (progressMsg as unknown as { message_id: number }).message_id, undefined, buildBulkCompleteText('Demote All Admins', demoted, failed), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
      }
      return;
    }

    // ── Approve Requests — Submenu ─────────────────────────────
    if (sub2 === 'approverequests' && !sub3) {
      const gcKey = storeGcJid(sessionId, gcJid);
      let pendingCount = 0;
      try {
        const pending = await sock.groupRequestParticipantsList(gcJid);
        pendingCount = pending.length;
      } catch { /* ignore */ }
      await ctx.editMessageText(
        [
          `<b>✅ Approve Requests</b>`,
          `<code>------------------------------</code>`,
          `<b>Pending Requests:</b> ${pendingCount}`,
          ``,
          `Choose how you want to approve pending join requests.`,
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [btn(`✅ Approve All (${pendingCount})`, `gcset:${sessionId}:${gcKey}:approverequests:all`, 'success')],
              [btn('🔢 Approve by Amount', `gcset:${sessionId}:${gcKey}:approverequests:byamount`, 'success')],
              [btn('🌍 Approve by Country', `gcset:${sessionId}:${gcKey}:approverequests:bycountry`, 'success')],
              [btn('🔙 Back', `gcset:${sessionId}:${gcKey}`, 'primary')],
            ],
          },
        }
      ).catch(() => {});
      return;
    }

    // ── Approve All — Confirm ──────────────────────────────────
    if (sub2 === 'approverequests' && sub3 === 'all' && !params[4]) {
      const gcKey = storeGcJid(sessionId, gcJid);
      let pending: Array<{ jid: string }> = [];
      try { pending = await sock.groupRequestParticipantsList(gcJid); } catch { /* ignore */ }
      if (pending.length === 0) {
        await ctx.editMessageText(noticeCard('No Pending Requests', 'There are currently no pending join requests.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) }).catch(() => {});
        return;
      }
      await ctx.editMessageText(
        [
          `<b>⚠️ Approve All Requests</b>`,
          `<code>------------------------------</code>`,
          `<b>Pending:</b> ${pending.length}`,
          ``,
          `This will approve all ${pending.length} pending join requests. Continue?`,
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [btn('✅ Yes, Approve All', `gcset:${sessionId}:${gcKey}:approverequests:all:run`, 'success'), btn('❌ Cancel', `gcset:${sessionId}:${gcKey}:approverequests`, 'primary')],
            ],
          },
        }
      ).catch(() => {});
      return;
    }

    // ── Approve All — Run ──────────────────────────────────────
    if (sub2 === 'approverequests' && sub3 === 'all' && params[4] === 'run') {
      const gcKey = storeGcJid(sessionId, gcJid);
      let pending: Array<{ jid: string }> = [];
      try { pending = await sock.groupRequestParticipantsList(gcJid); } catch (err) {
        await ctx.editMessageText(noticeCard('Failed', String(err), 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) }).catch(() => {});
        return;
      }
      if (pending.length === 0) {
        await ctx.editMessageText(noticeCard('No Pending Requests', 'There are currently no pending join requests.', 'warning'), { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
        return;
      }
      const progressMsg = await ctx.editMessageText(
        buildApproveProgressText(0, pending.length, 0),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      ).catch(() => null);
      let approved = 0, failed = 0;
      const BATCH = 10;
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH).map((r) => r.jid);
        try {
          await sock.groupRequestParticipantsUpdate(gcJid, batch, 'approve');
          approved += batch.length;
        } catch {
          // Try one-by-one on batch failure
          for (const jid of batch) {
            try { await sock.groupRequestParticipantsUpdate(gcJid, [jid], 'approve'); approved++; }
            catch { failed++; }
          }
        }
        if (progressMsg) {
          await ctx.telegram.editMessageText(ctx.chat!.id, (progressMsg as unknown as { message_id: number }).message_id, undefined, buildApproveProgressText(approved, pending.length - approved - failed, failed), { parse_mode: 'HTML' }).catch(() => {});
        }
        if (i + BATCH < pending.length) await sleep(800);
      }
      const finalText = [
        `<b>✅ Approve All — Complete</b>`,
        `<code>------------------------------</code>`,
        `<b>Pending Requests:</b> ${pending.length}`,
        ``,
        `<b>Approved:</b>\n✔ ${approved}`,
        ...(failed > 0 ? [`<b>Failed:</b> ${failed}`] : []),
        ``,
        `<i>Completed.</i>`,
      ].join('\n');
      if (progressMsg) {
        await ctx.telegram.editMessageText(ctx.chat!.id, (progressMsg as unknown as { message_id: number }).message_id, undefined, finalText, { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}`) }).catch(() => {});
      }
      return;
    }

    // ── Approve by Amount — Ask ────────────────────────────────
    if (sub2 === 'approverequests' && sub3 === 'byamount') {
      const gcKey = storeGcJid(sessionId, gcJid);
      ctx.session.awaitingApproveAmountSessionId = sessionId;
      ctx.session.awaitingApproveAmountGcJid = gcJid;
      await ctx.editMessageText(
        card('Approve by Amount', '🔢', [['Group', escape(gcJid)]], 'How many pending requests would you like to approve?\n\nSend a number, e.g. <code>25</code>.'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) }
      ).catch(() => {});
      return;
    }

    // ── Approve by Country — Ask ───────────────────────────────
    if (sub2 === 'approverequests' && sub3 === 'bycountry') {
      const gcKey = storeGcJid(sessionId, gcJid);
      ctx.session.awaitingApproveCountrySessionId = sessionId;
      ctx.session.awaitingApproveCountryGcJid = gcJid;
      await ctx.editMessageText(
        card('Approve by Country', '🌍', [['Group', escape(gcJid)]], 'Enter the country code to approve.\n\nExample: <code>+234</code>, <code>+1</code>, <code>+44</code>'),
        { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${sessionId}:${gcKey}:approverequests`) }
      ).catch(() => {});
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

  // ── Group Bridge ──
  if (action === 'gcbridge') {
    const sessionId = params[0];
    const gcKey = params[1];
    const sub = params[2]; // 'exit' to exit bridge

    if (sub === 'exit') {
      // Exit group bridge — clear state and return to dashboard
      const prevBridge = getGroupBridge(ctx.telegramId);
      clearGroupBridge(ctx.telegramId);
      // Also clear session state
      delete ctx.session.groupBridgeSessionId;
      delete ctx.session.groupBridgeGcJid;
      delete ctx.session.groupBridgeGcName;
      await ctx.answerCbQuery('Group Bridge exited', { show_alert: false }).catch(() => {});
      if (prevBridge) {
        // Return to group dashboard
        const gcJidBack = prevBridge.gcJid;
        const gcKeyBack = storeGcJid(prevBridge.sessionId, gcJidBack);
        await ctx.editMessageText(
          noticeCard('Group Bridge Closed', `Exited bridge for ${escape(prevBridge.gcName)}.`, 'success'),
          { parse_mode: 'HTML', reply_markup: backKeyboard(`gcset:${prevBridge.sessionId}:${gcKeyBack}`) }
        ).catch(() => {});
      } else {
        await ctx.editMessageText(mainMenu(ctx.telegramId, ctx.isOwner), {
          parse_mode: 'HTML',
          reply_markup: mainMenuKeyboard(ctx.isOwner),
        }).catch(() => {});
      }
      return;
    }

    if (!sessionId || !gcKey) return;
    const gcJid = gcJidStore.get(`${sessionId}:${gcKey}`) ?? (gcKey.includes('@') ? gcKey : undefined);
    if (!gcJid) {
      await ctx.answerCbQuery('Group not found — refresh the group list', { show_alert: true }).catch(() => {});
      return;
    }

    const socket = getSocket(sessionId);
    if (!socket || isFrozen(sessionId)) {
      await ctx.answerCbQuery('Session not connected', { show_alert: true }).catch(() => {});
      return;
    }

    // Fetch group name
    let gcName = gcJid.split('@')[0] ?? 'Group';
    try {
      const meta = await (socket as unknown as {
        groupMetadata(jid: string): Promise<{ subject?: string }>;
      }).groupMetadata(gcJid);
      gcName = meta?.subject ?? gcName;
    } catch { /* non-critical */ }

    // Set bridge state (both in-memory map and session)
    setGroupBridge(ctx.telegramId, sessionId, gcJid, gcName);
    ctx.session.groupBridgeSessionId = sessionId;
    ctx.session.groupBridgeGcJid = gcJid;
    ctx.session.groupBridgeGcName = gcName;

    const config = loadSessionConfig(ctx.telegramId, sessionId);

    await ctx.editMessageText(
      [
        `<b>🌉 Group Bridge Active</b>`,
        `<code>------------------------------</code>`,
        `<b>Group:</b> ${escape(gcName)}`,
        `<b>JID:</b> <code>${escape(gcJid)}</code>`,
        `<b>Session:</b> <code>${escape(sessionId)}</code>`,
        ``,
        `Every message you send now executes as a WhatsApp command inside this group.`,
        ``,
        `<b>Available commands include:</b>`,
        `<blockquote expandable>`,
        `${escape(config.prefix)}kick / ${escape(config.prefix)}ban / ${escape(config.prefix)}unban / ${escape(config.prefix)}banlist`,
        `${escape(config.prefix)}promote / ${escape(config.prefix)}demote`,
        `${escape(config.prefix)}warn / ${escape(config.prefix)}unwarn / ${escape(config.prefix)}warns`,
        `${escape(config.prefix)}poll Question | Option A | Option B`,
        `${escape(config.prefix)}tag / ${escape(config.prefix)}mtag`,
        `${escape(config.prefix)}antilink / ${escape(config.prefix)}antispam / ${escape(config.prefix)}antistatus`,
        `${escape(config.prefix)}welcomemsg / ${escape(config.prefix)}goodbyemsg`,
        `${escape(config.prefix)}kickmsg / ${escape(config.prefix)}warnmsg / ${escape(config.prefix)}banmsg`,
        `${escape(config.prefix)}eventstatus`,
        `${escape(config.prefix)}antistatus — full anti system overview`,
        `…and every other group command`,
        `</blockquote>`,
        ``,
        `Press <b>Exit Group Bridge</b> when done.`,
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: groupBridgeActiveKeyboard(sessionId, gcKey),
      }
    ).catch(() => {});
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
    if (sub === 'logs' && params[1] === 'stop') { stopLogStream(ctx.telegramId); await ctx.answerCbQuery('Stream stopped').catch(() => {}); return; }
    if (sub === 'logs') { await handleLogStream(ctx); return; }
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
            ? { inline_keyboard: [[btn('🗑 Clear URL', 'admin:menuurl:clear', 'danger')], [btn('🔙 Back', 'admin:panel', 'primary')]] }
            : { inline_keyboard: [[btn('🔙 Back', 'admin:panel', 'primary')]] },
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

// ============================================================
// WA-Bridge — Session Management Telegram Handlers
// Pair, freeze, re-init, purge, bridge
// ============================================================

import type { Context } from 'telegraf';
import { v4 as uuid } from 'uuid';
import type { SessionMeta } from '../../types/index.js';
import {
  loadAllSessions,
  saveSessionMeta,
  loadSessionMeta,
  purgeSession as wsPurgeSession,
  loadConfig,
  updateSessionMeta,
  loadPlatformSessions,
} from '../../services/workspace.js';
import {
  initSocket,
  reinitSocket,
  closeSocket,
  freezeSession,
  unfreezeSession,
  getUserSockets,
  getSocket,
  normalizePairingPhone,
} from '../../whatsapp/socket-manager.js';
import { registerSessionOwner } from '../../whatsapp/event-handlers.js';
import {
  sessionsListKeyboard,
  sessionMenuKeyboard,
  sessionPairKeyboard,
  pairingCodeKeyboard,
  confirmKeyboard,
  backKeyboard,
  bridgeExitKeyboard,
  linkCollectionKeyboard,
  joinManagerKeyboard,
} from '../ui/keyboards.js';
import {
  sessionCard,
  pairingCodeCard,
  header,
  H,
  escape,
  card,
  noticeCard,
} from '../../utils/formatter.js';
// ── Session ID Generator ──────────────────────────────────

function makeSessionId(telegramId: string, phone: string): string {
  return `1_${telegramId}_${phone.replace(/\D/g, '')}`;
}
import {
  getJoinManagerState,
  pauseJoinManager,
  startJoinManager,
  stopJoinManager,
} from '../../services/join-manager.js';

// ── Fetch WA profile (name + photo) after connect ────────

async function fetchWAProfile(
  socket: WASocket,
  jid: string
): Promise<{ name: string; photoBuffer: Buffer | null }> {
  let name = 'Unknown';
  let photoBuffer: Buffer | null = null;
  try {
    const info = await (socket as unknown as {
      fetchBusinessProfile(jid: string): Promise<{ name?: string } | null>;
    }).fetchBusinessProfile(jid).catch(() => null);
    if (info?.name) name = info.name;
    else {
      const contacts = (socket as unknown as { store?: { contacts?: Record<string, { name?: string; notify?: string }> } }).store?.contacts;
      const contact = contacts?.[jid];
      if (contact?.name) name = contact.name;
      else if (contact?.notify) name = contact.notify;
    }
  } catch { /* ignore */ }
  try {
    const ppUrl = await (socket as unknown as {
      profilePictureUrl(jid: string, type: string): Promise<string | null>;
    }).profilePictureUrl(jid, 'image').catch(() => null);
    if (ppUrl) {
      const res = await fetch(ppUrl);
      if (res.ok) photoBuffer = Buffer.from(await res.arrayBuffer());
    }
  } catch { /* ignore */ }
  return { name, photoBuffer };
}



// ── List Sessions ─────────────────────────────────────────

export async function handleSessionsList(
  ctx: Context & { telegramId: string; isOwner?: boolean },
  page = 0
): Promise<void> {
  const sessions = ctx.isOwner ? loadPlatformSessions() : Object.values(loadAllSessions(ctx.telegramId));

  if (sessions.length === 0) {
    await ctx.editMessageText?.(
      noticeCard(ctx.isOwner ? 'Platform WhatsApp Sessions' : 'Your WhatsApp Sessions', 'No sessions are configured yet. Create your first session below.', 'info'),
      {
        parse_mode: 'HTML',
        reply_markup: sessionsListKeyboard([], 0),
      }
    ) ?? await ctx.reply(
      noticeCard(ctx.isOwner ? 'Platform WhatsApp Sessions' : 'Your WhatsApp Sessions', 'No sessions are configured yet.', 'info'),
      { parse_mode: 'HTML', reply_markup: sessionsListKeyboard([], 0) }
    );
    return;
  }

  const text = card(ctx.isOwner ? 'Platform WhatsApp Sessions' : 'Your WhatsApp Sessions', '📱', [['Configured', String(sessions.length)]], 'Select a named session to view controls or create another one.');
  const sessionList = sessions.map((s) => ({
    id: s.sessionId,
    phone: s.phone,
    label: ctx.isOwner ? `${s.label ?? s.phone} (${s.telegramId})` : s.label,
    status: s.status,
  }));

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: sessionsListKeyboard(sessionList, page),
    }).catch(() => {});
  } else {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: sessionsListKeyboard(sessionList, page),
    });
  }
}

// ── New Session Flow ──────────────────────────────────────

export async function handleNewSession(
  ctx: Context & { telegramId: string },
  phone?: string,
  label?: string
): Promise<void> {
  if (!phone) {
    await ctx.editMessageText?.(
      `${header('Add New Session', '➕')}\n\n` +
      `Send your WhatsApp number in international format:\n${H.code('+1234567890')}\n\n` +
      `Or click a pairing method below.`,
      {
        parse_mode: 'HTML',
        reply_markup: sessionPairKeyboard('new'),
      }
    ) ?? await ctx.reply(
      'Send your phone number in international format (e.g., +1234567890):',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const sessionId = makeSessionId(ctx.telegramId, phone);
  const existing = loadSessionMeta(ctx.telegramId, sessionId);

  if (existing && existing.status === 'open') {
    await ctx.reply(noticeCard('Session Already Active', `A connected session already exists for ${phone}.`, 'warning'), { parse_mode: 'HTML' });
    return;
  }

  const meta: SessionMeta = {
    ...(existing ?? {
      sessionId,
      telegramId: ctx.telegramId,
      phone,
      errorCount: 0,
      autoJoinDone: false,
    }),
    label: label ?? existing?.label,
    phone,
    status: 'connecting',
    pairMethod: 'qr',
  };

  saveSessionMeta(meta);
  registerSessionOwner(sessionId, ctx.telegramId);

  const progressMsg = await ctx.reply(
    card('Connecting Session', '🔄', [['Name', meta.label || meta.phone], ['Owner', meta.phone], ['Method', 'QR code']], 'Preparing a secure WhatsApp pairing session.'),
    { parse_mode: 'HTML' }
  );

  try {
    await initSocket(meta, {
      usePairingCode: false,
      onQR: async (dataUrl) => {
        // Convert QR data URL to buffer and send as photo
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        await ctx.replyWithPhoto(
          { source: buffer },
          {
            caption: card('Scan QR Code', '📷', [['Session', meta.label || meta.phone], ['Owner', meta.phone], ['Expires', '60 seconds']], 'Open WhatsApp → Linked Devices → Link a Device → Scan QR.'),
            parse_mode: 'HTML',
          }
        );
      },
      onConnected: async (sid) => {
        const socket = getSocket(sid);
        const ownJid = (socket as unknown as { user?: { id?: string } })?.user?.id ?? '';
        const { name: waName, photoBuffer } = socket && ownJid
          ? await fetchWAProfile(socket, ownJid)
          : { name: meta.label || meta.phone, photoBuffer: null };
        const displayName = waName !== 'Unknown' ? waName : (meta.label || meta.phone);

        const connectedText = [
          `🟢 <b>Session Connected!</b>`,
          ``,
          `👤 <b>Name:</b> ${escape(displayName)}`,
          `📱 <b>Number:</b> <code>${escape(meta.phone)}</code>`,
          `🔑 <b>Session:</b> <code>${escape(sid)}</code>`,
          `🔗 <b>Method:</b> QR Code`,
          `⏰ <b>Paired:</b> ${new Date().toLocaleString()}`,
          ``,
          `<blockquote>Ready for WhatsApp commands. Use the menu below to manage this session.</blockquote>`,
        ].join('\n');

        // Edit the progress message
        await ctx.telegram.editMessageText(
          ctx.chat!.id, progressMsg.message_id, undefined,
          connectedText,
          { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sid) }
        ).catch(() => {});

        // DM the owner with photo if available
        try {
          if (photoBuffer) {
            await ctx.telegram.sendPhoto(
              parseInt(ctx.telegramId, 10),
              { source: photoBuffer },
              { caption: connectedText, parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sid) }
            );
          } else {
            await ctx.telegram.sendMessage(
              parseInt(ctx.telegramId, 10), connectedText,
              { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sid) }
            );
          }
        } catch { /* same chat or blocked */ }
      },
    });
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      noticeCard('Connection Failed', 'The QR session could not be connected.', 'error', String(err)),
      { parse_mode: 'HTML' }
    );
  }
}

// ── Pairing Code Flow ─────────────────────────────────────

export async function handlePairingCode(
  ctx: Context & { telegramId: string },
  sessionId: string,
  phone: string
): Promise<void> {
  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePairingPhone(phone);
  } catch (error) {
    await ctx.reply(noticeCard('Invalid Phone Number', error instanceof Error ? error.message : String(error), 'error'), {
      parse_mode: 'HTML',
    });
    return;
  }

  const existing = loadSessionMeta(ctx.telegramId, sessionId);
  if (existing?.status === 'open') {
    await ctx.reply(noticeCard('Session Already Connected', 'This WhatsApp owner already has an active session.', 'warning'), { parse_mode: 'HTML' });
    return;
  }

  const meta: SessionMeta = {
    ...(existing ?? {
      sessionId,
      telegramId: ctx.telegramId,
      phone: normalizedPhone,
      autoJoinDone: false,
    }),
    phone: normalizedPhone,
    status: 'connecting',
    pairMethod: 'code',
    errorCount: 0,
  };

  saveSessionMeta(meta);
  registerSessionOwner(sessionId, ctx.telegramId);
  const progress = await ctx.reply(`${header('Preparing Pairing', '🔄')}\n\nRequesting the secure PAPPY-BOT code...`, {
    parse_mode: 'HTML',
  });

  try {
    await reinitSocket(meta, {
      usePairingCode: true,
      phone: normalizedPhone,
      onPairingCode: async (code) => {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progress.message_id,
          undefined,
          pairingCodeCard(normalizedPhone, code),
          { parse_mode: 'HTML', reply_markup: pairingCodeKeyboard(code) }
        );
      },
      onPairingError: async (error) => {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progress.message_id,
          undefined,
          `${header('Pairing Request Failed', '🔴')}\n\n${H.code(error.message)}\n\nNo WhatsApp session data was deleted.`,
          { parse_mode: 'HTML', reply_markup: sessionPairKeyboard(sessionId) }
        ).catch(() => {});
      },
      onConnected: async () => {
        const socket = getSocket(sessionId);
        const ownJid = (socket as unknown as { user?: { id?: string } })?.user?.id ?? '';
        const { name: waName, photoBuffer } = socket && ownJid
          ? await fetchWAProfile(socket, ownJid)
          : { name: meta.label || normalizedPhone, photoBuffer: null };
        const displayName = waName !== 'Unknown' ? waName : (meta.label || normalizedPhone);

        const connectedText = [
          `🟢 <b>Session Connected!</b>`,
          ``,
          `👤 <b>Name:</b> ${escape(displayName)}`,
          `📱 <b>Number:</b> <code>${escape(normalizedPhone)}</code>`,
          `🔑 <b>Session:</b> <code>${escape(sessionId)}</code>`,
          `🔗 <b>Method:</b> Pairing Code`,
          `⏰ <b>Paired:</b> ${new Date().toLocaleString()}`,
          ``,
          `<blockquote>Ready for WhatsApp commands. Use the menu below to manage this session.</blockquote>`,
        ].join('\n');

        // Edit the pairing message
        await ctx.telegram.editMessageText(
          ctx.chat!.id, progress.message_id, undefined,
          connectedText,
          { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
        ).catch(() =>
          ctx.telegram.sendMessage(ctx.chat!.id, connectedText, { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }).catch(() => {})
        );

        // DM the owner with photo if available
        try {
          if (photoBuffer) {
            await ctx.telegram.sendPhoto(
              parseInt(ctx.telegramId, 10),
              { source: photoBuffer },
              { caption: connectedText, parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
            );
          } else {
            await ctx.telegram.sendMessage(
              parseInt(ctx.telegramId, 10), connectedText,
              { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
            );
          }
        } catch { /* same chat or blocked */ }
      },
    });
  } catch (error) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progress.message_id,
      undefined,
      `${header('Pairing Failed', '🔴')}\n\n${H.code(error instanceof Error ? error.message : String(error))}`,
      { parse_mode: 'HTML', reply_markup: sessionPairKeyboard(sessionId) }
    ).catch(() => {});
  }
}

// ── Session Info ──────────────────────────────────────────

export async function handleSessionInfo(
  ctx: Context & { telegramId: string },
  sessionId: string
): Promise<void> {
  const meta = loadSessionMeta(ctx.telegramId, sessionId);
  if (!meta) {
    await ctx.answerCbQuery('Session not found').catch(() => {});
    return;
  }

  const socket = getSocket(sessionId);
  let groupCount = 0;
  if (socket) {
    try {
      const groups = await socket.groupFetchAllParticipating();
      groupCount = Object.keys(groups).length;
    } catch { /* ignore */ }
  }

  await ctx.editMessageText(
    sessionCard({
      sessionId,
      label: meta.label,
      phone: meta.phone,
      status: meta.status,
      paired: meta.status === 'open',
      groups: groupCount,
      frozen: meta.status === 'frozen',
    }),
    { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
  ).catch(() => {});
}

// ── Freeze / Unfreeze ─────────────────────────────────────

export async function handleFreezeSession(
  ctx: Context & { telegramId: string },
  sessionId: string
): Promise<void> {
  freezeSession(sessionId);
  await ctx.answerCbQuery('Session frozen ❄️').catch(() => {});
  await ctx.editMessageText(
    `${header('Session Frozen', '❄️')}\n\n${H.code(sessionId)}\n\nTraffic paused. Use Unfreeze to resume.`,
    { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
  ).catch(() => {});
}

export async function handleUnfreezeSession(
  ctx: Context & { telegramId: string },
  sessionId: string
): Promise<void> {
  unfreezeSession(sessionId);
  await ctx.answerCbQuery('Session unfrozen 🔥').catch(() => {});
  await ctx.editMessageText(
    `${header('Session Active', '🟢')}\n\n${H.code(sessionId)}\n\nTraffic resumed.`,
    { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
  ).catch(() => {});
}

// ── Re-Init ───────────────────────────────────────────────

export async function handleReinitSession(
  ctx: Context & { telegramId: string },
  sessionId: string
): Promise<void> {
  const meta = loadSessionMeta(ctx.telegramId, sessionId);
  if (!meta) return;

  await ctx.answerCbQuery('Re-initializing…').catch(() => {});
  const msg = await ctx.reply(`${header('Reinitializing', '🔄')}\n\n${H.code(sessionId)}`, { parse_mode: 'HTML' });

  try {
    await reinitSocket(meta, {
      onConnected: async () => {
        const socket = getSocket(sessionId);
        const ownJid = (socket as unknown as { user?: { id?: string } })?.user?.id ?? '';
        const { name: waName, photoBuffer } = socket && ownJid
          ? await fetchWAProfile(socket, ownJid)
          : { name: meta.label || meta.phone, photoBuffer: null };
        const displayName = waName !== 'Unknown' ? waName : (meta.label || meta.phone);
        const reinitText = [
          `🟢 <b>Session Reconnected!</b>`,
          ``,
          `👤 <b>Name:</b> ${escape(displayName)}`,
          `📱 <b>Number:</b> <code>${escape(meta.phone)}</code>`,
          `🔑 <b>Session:</b> <code>${escape(sessionId)}</code>`,
          `⏰ <b>At:</b> ${new Date().toLocaleString()}`,
          ``,
          `<blockquote>Session successfully reinitialized and ready.</blockquote>`,
        ].join('\n');
        await ctx.telegram.editMessageText(
          ctx.chat!.id, msg.message_id, undefined,
          reinitText,
          { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
        ).catch(() => {});
        try {
          if (photoBuffer) {
            await ctx.telegram.sendPhoto(
              parseInt(ctx.telegramId, 10),
              { source: photoBuffer },
              { caption: reinitText, parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
            );
          } else {
            await ctx.telegram.sendMessage(
              parseInt(ctx.telegramId, 10), reinitText,
              { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
            );
          }
        } catch { /* ignore */ }
      },
    });
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      undefined,
      `${header('Reinit Failed', '🔴')}\n\n${H.pre(String(err), 'log')}`,
      { parse_mode: 'HTML' }
    );
  }
}

// ── Purge Session ─────────────────────────────────────────

export async function handlePurgeSession(
  ctx: Context & { telegramId: string },
  sessionId: string
): Promise<void> {
  await ctx.editMessageText(
    `${header('Confirm Purge', '⚠️')}\n\n${H.bold('This will permanently delete:')}\n• Auth state\n• Session logs\n• All session data\n\nFor: ${H.code(sessionId)}`,
    {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard(
        `session:${sessionId}:purge:confirm`,
        `session:${sessionId}:menu`
      ),
    }
  ).catch(() => {});
}

export async function handlePurgeConfirm(
  ctx: Context & { telegramId: string },
  sessionId: string
): Promise<void> {
  await closeSocket(sessionId);
  wsPurgeSession(ctx.telegramId, sessionId);

  await ctx.editMessageText(
    `${header('Session Purged', '🗑')}\n\n${H.code(sessionId)} has been permanently deleted.`,
    { parse_mode: 'HTML', reply_markup: backKeyboard('sessions:list') }
  ).catch(() => {});
}

// ── Per-session Automation ────────────────────────────────

export async function handleLinkCollection(
  ctx: Context & { telegramId: string },
  sessionId: string,
  enabled?: boolean
): Promise<void> {
  let meta = loadSessionMeta(ctx.telegramId, sessionId);
  if (!meta) return;
  if (enabled !== undefined) meta = updateSessionMeta(ctx.telegramId, sessionId, { linkCollectionEnabled: enabled }) ?? meta;
  await ctx.editMessageText(
    card('Session Link Collection', '🔗', [
      ['Session', meta.label || meta.phone],
      ['Status', meta.linkCollectionEnabled ? 'Enabled' : 'Disabled'],
      ['Links collected', String(meta.linksCollected ?? 0)],
      ['Destination', 'Main bucket'],
    ], 'Invite links from every message are collected silently only for this session.'),
    { parse_mode: 'HTML', reply_markup: linkCollectionKeyboard(sessionId, Boolean(meta.linkCollectionEnabled)) }
  ).catch(() => {});
}

export async function handleJoinManager(
  ctx: Context & { telegramId: string },
  sessionId: string,
  operation?: 'start' | 'pause' | 'stop'
): Promise<void> {
  const socket = getSocket(sessionId);
  if (operation === 'start') {
    if (!socket) {
      await ctx.answerCbQuery('Session is not connected', { show_alert: true }).catch(() => {});
    } else {
      void startJoinManager(ctx.telegramId, sessionId, socket);
    }
  } else if (operation === 'pause') pauseJoinManager(ctx.telegramId, sessionId);
  else if (operation === 'stop') stopJoinManager(ctx.telegramId, sessionId);

  const state = getJoinManagerState(ctx.telegramId, sessionId);
  const logs = state.logs.slice(-8).map((line, index) => `${index + 1}. ${escape(line)}`).join('\n') || 'No activity yet.';
  await ctx.editMessageText([
    card('Link Join Manager', '🚪', [
      ['Source', 'Active bucket'], ['Status', state.status],
      ['Progress', `${state.cursor}/${state.total}`], ['Joined', String(state.joined)],
      ['Skipped', String(state.skipped)], ['Failed', String(state.failed)],
    ], state.currentLink ? `Current: ${state.currentLink}` : 'Jobs are isolated per session and stop after five restriction failures.'),
    H.blockquote(logs, true),
  ].join('\n\n'), { parse_mode: 'HTML', reply_markup: joinManagerKeyboard(sessionId, state.status) }).catch(() => {});
}

// ── Bridge Mode ───────────────────────────────────────────

const bridgeSessions = new Map<string, string>(); // telegramId → sessionId

export function getBridgeSession(telegramId: string): string | null {
  return bridgeSessions.get(telegramId) ?? null;
}

export async function handleBridgeSession(
  ctx: Context & { telegramId: string },
  sessionId: string
): Promise<void> {
  bridgeSessions.set(ctx.telegramId, sessionId);

  await ctx.editMessageText(
    `${header('Bridge Mode Active', '🌉')}\n\n` +
    `Any message you send will be executed as a command on ${H.code(sessionId)}\n\n` +
    `${H.blockquote('Type your command (e.g., .ping, .allstatus [msg])\nSend /unbind to exit bridge mode.')}\n\n` +
    `${H.italic('⚠️ Commands run on the WhatsApp session directly.')}`,
    { parse_mode: 'HTML', reply_markup: bridgeExitKeyboard() }
  ).catch(() => {});
}

export function handleBridgeExit(telegramId: string): void {
  bridgeSessions.delete(telegramId);
}

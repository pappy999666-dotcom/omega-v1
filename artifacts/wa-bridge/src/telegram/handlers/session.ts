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
  isFrozen,
  normalizePairingPhone,
  markPurged,
} from '../../whatsapp/socket-manager.js';
import { registerSessionOwner } from '../../whatsapp/event-handlers.js';
import type { BridgeWASocket as WASocket } from '../../whatsapp/baileys-types.js';
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

function makeSessionId(telegramId: string, sessionName: string): string {
  const safeName = sessionName.toLowerCase().replace(/\W/g, '_');
  const shortId = uuid().slice(0, 8);
  return `${telegramId}_${safeName}_${shortId}`;
}
import {
  getJoinManagerState,
  pauseJoinManager,
  startJoinManager,
  stopJoinManager,
  subscribeJoinManager,
} from '../../services/join-manager.js';
import { connectedCard } from '../../utils/ascii-art.js';
import { notifySessionConnected } from '../../services/session-connected.js';

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
  // Show open sessions + sessions the user explicitly froze this runtime
  // (frozen = socket is live but paused). Stale frozen from previous boot are excluded.
  const sessions = Object.values(loadAllSessions(ctx.telegramId))
    .filter((s) => s.status !== 'PURGED');

  if (sessions.length === 0) {
    await ctx.editMessageText?.(
      noticeCard('Your WhatsApp Sessions', 'No sessions are configured yet. Create your first session below.', 'info'),
      { parse_mode: 'HTML', reply_markup: sessionsListKeyboard([], 0) }
    ) ?? await ctx.reply(
      noticeCard('Your WhatsApp Sessions', 'No sessions are configured yet.', 'info'),
      { parse_mode: 'HTML', reply_markup: sessionsListKeyboard([], 0) }
    );
    return;
  }

  const text = card('Your WhatsApp Sessions', '📱', [['Configured', String(sessions.length)]], 'Select a session to view controls or create another one.');
  const sessionList = sessions.map((s) => ({
    id: s.sessionId,
    phone: s.phone,
    label: s.label,
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
    sessionId,
    telegramId: ctx.telegramId,
    sessionName: label || 'Main',
    phone,
    errorCount: 0,
    autoJoinDone: false,
    label: label,
    status: 'PAIRING',
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
      onConnected: async (sid, isFirstTime) => {
        const socket = getSocket(sid);
        // Centralized connected notification service handles deduplication.
        // We notify on every connect to ensure state is synchronized.
        await notifySessionConnected({
          telegramChatId: ctx.chat!.id,
          telegram: {
            sendMessage: (chatId, text, opts) => ctx.telegram.sendMessage(chatId, text, opts as any) as any,
            editMessageText: (chatId, msgId, _, text, replyOpts) => ctx.telegram.editMessageText(chatId, msgId, undefined, text, replyOpts as any) as any,
            sendPhoto: (chatId, photo, opts) => ctx.telegram.sendPhoto(chatId, photo as any, opts as any) as any,
          },
          socket: socket ?? undefined,
          sessionId: sid,
          phone: meta.phone,
          label: meta.label,
          method: 'QR Code',
          replyMarkup: sessionMenuKeyboard(sid, 'ACTIVE') as unknown as Record<string, unknown>,
          progressMsgId: progressMsg.message_id,
          ownerTelegramId: ctx.telegramId,
          force: true, // New pairing always sends notification
        });
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
    sessionId,
    telegramId: ctx.telegramId,
    sessionName: 'Main', // Default name for pairing code flow if not specified
    phone: normalizedPhone,
    errorCount: 0,
    autoJoinDone: false,
    status: 'PAIRING',
    pairMethod: 'code',
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
      onConnected: async (sid, isFirstTime) => {
        const socket = getSocket(sessionId);
        // Centralized connected notification service handles deduplication.
        await notifySessionConnected({
          telegramChatId: ctx.chat!.id,
          telegram: {
            sendMessage: (chatId, text, opts) => ctx.telegram.sendMessage(chatId, text, opts as any) as any,
            editMessageText: (chatId, msgId, _, text, replyOpts) => ctx.telegram.editMessageText(chatId, msgId, undefined, text, replyOpts as any) as any,
            sendPhoto: (chatId, photo, opts) => ctx.telegram.sendPhoto(chatId, photo as any, opts as any) as any,
          },
          socket: socket ?? undefined,
          sessionId,
          phone: normalizedPhone,
          label: meta.label,
          method: 'Pairing Code',
          replyMarkup: sessionMenuKeyboard(sessionId, 'ACTIVE') as unknown as Record<string, unknown>,
          progressMsgId: progress.message_id,
          ownerTelegramId: ctx.telegramId,
          force: true, // New pairing always sends notification
        });
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
        label: meta.sessionName,
        phone: meta.phone,
        status: meta.status,
        paired: meta.status === 'ACTIVE',
        groups: groupCount,
        frozen: meta.status === 'FROZEN',
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
    { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId, 'frozen') }
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
    { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId, 'ACTIVE') }
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
      onConnected: async (sid, isFirstTime) => {
        const socket = getSocket(sessionId);
        // Delegate to centralized connected notification service
        await notifySessionConnected({
          telegramChatId: ctx.chat!.id,
          telegram: {
            sendMessage: (chatId, text, opts) => ctx.telegram.sendMessage(chatId, text, opts as any) as any,
            editMessageText: (chatId, msgId, _, text, replyOpts) => ctx.telegram.editMessageText(chatId, msgId, undefined, text, replyOpts as any) as any,
            sendPhoto: (chatId, photo, opts) => ctx.telegram.sendPhoto(chatId, photo as any, opts as any) as any,
          },
          socket: socket ?? undefined,
          sessionId,
          phone: meta.phone,
          label: meta.label,
          method: 'Reinit',
          replyMarkup: sessionMenuKeyboard(sessionId, 'ACTIVE') as unknown as Record<string, unknown>,
          progressMsgId: msg.message_id,
          ownerTelegramId: ctx.telegramId,
          force: true,
        });
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
  markPurged(sessionId);
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

// ── Active join manager subscriptions (telegramId → unsub fn) ──────────
const activeJoinSubs = new Map<string, () => void>();

export function clearJoinManagerSub(telegramId: string): void {
  activeJoinSubs.get(telegramId)?.();
  activeJoinSubs.delete(telegramId);
}

export async function handleJoinManager(
  ctx: Context & { telegramId: string; chat?: { id: number } },
  sessionId: string,
  operation?: 'start' | 'pause' | 'stop' | 'setlimit' | 'setdelay'
): Promise<void> {
  const socket = getSocket(sessionId);

  if (operation === 'start') {
    if (!socket) {
      await ctx.answerCbQuery('Session is not connected', { show_alert: true }).catch(() => {});
    } else {
      const { loadSessionMeta: lsm } = await import('../../services/workspace.js');
      const m = lsm(ctx.telegramId, sessionId);
      const limit = (m as any)?.joinSettings?.maxLinksPerRun ?? 0;
      const delayMs = (m as any)?.joinSettings?.delayMs ?? 0;
      void startJoinManager(ctx.telegramId, sessionId, socket, {
        ...(limit > 0 ? { maxLinksPerRun: limit } : {}),
        ...(delayMs > 0 ? { minDelayMs: delayMs, maxDelayMs: delayMs + 2000 } : {}),
      });
    }
  } else if (operation === 'pause') {
    pauseJoinManager(ctx.telegramId, sessionId);
  } else if (operation === 'stop') {
    stopJoinManager(ctx.telegramId, sessionId);
  } else if (operation === 'setlimit' || operation === 'setdelay') {
    const isLimit = operation === 'setlimit';
    await ctx.editMessageText(
      card(isLimit ? 'Set Join Limit' : 'Set Join Delay', '⚙️', [['Session', sessionId]],
        isLimit ? 'Send the max groups to join per run (e.g. 100). Send 0 for unlimited.'
                : 'Send delay in seconds between each join (1–60).'),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `session:${sessionId}:joinmgr` }]] } }
    ).catch(() => {});
    await ctx.answerCbQuery(`Send the ${isLimit ? 'limit' : 'delay'} now`).catch(() => {});
    return;
  }

  const state = getJoinManagerState(ctx.telegramId, sessionId);
  const { loadSessionMeta: lsm2 } = await import('../../services/workspace.js');
  const m2 = lsm2(ctx.telegramId, sessionId) as any;
  const limitDisplay = m2?.joinSettings?.maxLinksPerRun ? String(m2.joinSettings.maxLinksPerRun) : 'Unlimited';
  const delayDisplay = m2?.joinSettings?.delayMs ? `${m2.joinSettings.delayMs / 1000}s` : 'Auto';
  const logs = state.logs.slice(-10).map((line, i) => `${i + 1}. ${escape(line)}`).join('\n') || 'No activity yet.';

  const msgText = [
    card('Link Join Manager', '🚪', [
      ['Source', 'Active bucket'], ['Status', state.status],
      ['Progress', `${state.cursor}/${state.total}`], ['In Groups', `📊 ${state.gcCount != null && state.gcCount >= 0 ? state.gcCount : '?'}`],
      ['Joined', String(state.joined)], ['Skipped', String(state.skipped)],
      ['Failed', String(state.failed)], ['Rate Limits', `${state.rateLimitHits ?? 0}/5`],
      ['Join Limit', limitDisplay], ['Delay', delayDisplay],
    ], state.currentLink ? `Current: ${state.currentLink.slice(-40)}` : 'Jobs stop at 5 rate limit hits.'),
    H.blockquote(logs, true),
  ].join('\n\n');

  const sentMsg = await ctx.editMessageText(msgText, {
    parse_mode: 'HTML',
    reply_markup: joinManagerKeyboard(sessionId, state.status),
  }).catch(() => null);

  const chatId = ctx.chat?.id ?? (ctx as any).callbackQuery?.message?.chat?.id;
  if (state.status === 'running' && sentMsg && chatId) {
    const msgId = (sentMsg as unknown as { message_id?: number }).message_id;
    if (!msgId) return;
    // Kill any previous subscription for this user before starting a new one
    clearJoinManagerSub(ctx.telegramId);
    let lastEdit = Date.now();
    let unsub: (() => void) | null = null;
    const timeout = setTimeout(() => { unsub?.(); activeJoinSubs.delete(ctx.telegramId); }, 90_000);
    unsub = subscribeJoinManager(sessionId, async (s) => {
      if (Date.now() - lastEdit < 1500) return;
      lastEdit = Date.now();
      const ll = s.logs.slice(-10).map((line, i) => `${i + 1}. ${escape(line)}`).join('\n') || 'No activity yet.';
      const lt = [
        card('Link Join Manager', '🚪', [
          ['Status', s.status], ['Progress', `${s.cursor}/${s.total}`],
          ['In Groups', `📊 ${s.gcCount != null && s.gcCount >= 0 ? s.gcCount : '?'}`],
          ['Joined', String(s.joined)], ['Skipped', String(s.skipped)],
          ['Failed', String(s.failed)], ['Rate Limits', `${s.rateLimitHits ?? 0}/5`],
          ['Join Limit', limitDisplay], ['Delay', delayDisplay],
        ], s.currentLink ? `Current: ${s.currentLink.slice(-40)}` : ''),
        H.blockquote(ll, true),
      ].join('\n\n');
      await ctx.telegram.editMessageText(chatId, msgId, undefined, lt, {
        parse_mode: 'HTML',
        reply_markup: joinManagerKeyboard(sessionId, s.status),
      }).catch(() => {});
      if (s.status !== 'running') {
        clearTimeout(timeout);
        unsub?.();
        activeJoinSubs.delete(ctx.telegramId);
      }
    });
    activeJoinSubs.set(ctx.telegramId, () => { clearTimeout(timeout); unsub?.(); });
  }
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

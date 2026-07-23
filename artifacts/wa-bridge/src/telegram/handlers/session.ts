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
} from '../ui/keyboards.js';
import {
  sessionCard,
  pairingCodeCard,
  header,
  H,
  escape,
} from '../../utils/formatter.js';
import { logger } from '../../utils/logger.js';

// ── Session ID Generator ──────────────────────────────────

function makeSessionId(telegramId: string, phone: string): string {
  return `1_${telegramId}_${phone.replace(/\D/g, '')}`;
}

// ── List Sessions ─────────────────────────────────────────

export async function handleSessionsList(
  ctx: Context & { telegramId: string },
  page = 0
): Promise<void> {
  const sessions = Object.values(loadAllSessions(ctx.telegramId));

  if (sessions.length === 0) {
    await ctx.editMessageText?.(
      `${header('Your WhatsApp Sessions', '📱')}\n\n<i>No sessions yet. Pair your first number below!</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: sessionsListKeyboard([], 0),
      }
    ) ?? await ctx.reply(
      `${header('Your WhatsApp Sessions', '📱')}\n\n<i>No sessions yet.</i>`,
      { parse_mode: 'HTML', reply_markup: sessionsListKeyboard([], 0) }
    );
    return;
  }

  const text = `${header('Your WhatsApp Sessions', '📱')}\n\n${H.italic(`${sessions.length} session(s) configured`)}`;
  const sessionList = sessions.map((s) => ({
    id: s.sessionId,
    phone: s.phone,
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
  phone?: string
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
    await ctx.reply(`⚠️ Session for ${H.code(phone)} is already active.`, { parse_mode: 'HTML' });
    return;
  }

  const meta: SessionMeta = existing ?? {
    sessionId,
    telegramId: ctx.telegramId,
    phone,
    status: 'connecting',
    pairMethod: 'qr',
    errorCount: 0,
    autoJoinDone: false,
  };

  saveSessionMeta(meta);
  registerSessionOwner(sessionId, ctx.telegramId);

  const progressMsg = await ctx.reply(
    `${header('Connecting…', '🔄')}\n\n${H.italic('Generating pairing options…')}`,
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
            caption: `${header('Scan QR Code', '📷')}\n\n${H.italic('Open WhatsApp → Linked Devices → Link a Device → Scan QR')}\n\n${H.italic('QR expires in 60s')}`,
            parse_mode: 'HTML',
          }
        );
      },
      onConnected: async (sid) => {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progressMsg.message_id,
          undefined,
          `${header('Session Connected', '🟢')}\n\n${H.code(sessionId)}`,
          {
            parse_mode: 'HTML',
            reply_markup: sessionMenuKeyboard(sessionId),
          }
        );
      },
    });
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      `${header('Connection Failed', '🔴')}\n\n${H.pre(String(err), 'log')}`,
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
    await ctx.reply(`${header('Invalid Phone Number', '🔴')}\n\n${H.code(error instanceof Error ? error.message : String(error))}`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const existing = loadSessionMeta(ctx.telegramId, sessionId);
  if (existing?.status === 'open') {
    await ctx.reply(`Session ${H.code(sessionId)} is already connected.`, { parse_mode: 'HTML' });
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
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progress.message_id,
          undefined,
          `${header('Session Connected!', '🟢')}\n\nPhone: ${H.code(normalizedPhone)}`,
          { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
        ).catch(() => {});
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
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          msg.message_id,
          undefined,
          `${header('Reinitialized', '🟢')}\n\n${H.code(sessionId)}`,
          { parse_mode: 'HTML', reply_markup: sessionMenuKeyboard(sessionId) }
        );
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

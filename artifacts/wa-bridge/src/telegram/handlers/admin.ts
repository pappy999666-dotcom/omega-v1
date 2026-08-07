// ============================================================
// WA-Bridge — Admin Panel Telegram Handlers
// Platform governance, omni-bridge, master bucket, etc.
// ============================================================

import type { Context } from 'telegraf';
import { loadConfig, updateConfig, purgeAllSessions, loadBucket, getAllUserIds, loadPlatformConfig, updatePlatformConfig } from '../../services/workspace.js';
import { getAllSockets } from '../../whatsapp/socket-manager.js';
import { getMasterActiveBucket, exportBucket } from '../../services/tri-bucket.js';
import { enqueueJob, omniQueue } from '../../services/queue.js';
import {
  setMaintenanceMode,
  setGlobalPause,
  isMaintenanceMode,
  isGlobalPaused,
} from '../middlewares/auth.js';
import {
  adminPanelKeyboard,
  adminUsersKeyboard,
  adminUserKeyboard,
  permissionPanelKeyboard,
  confirmKeyboard,
  backKeyboard,
  btn,
} from '../ui/keyboards.js';
import { header, H, kv, bucketCard, noticeCard, escape, card } from '../../utils/formatter.js';
import { logger } from '../../utils/logger.js';
import { runDeployment } from '../../services/deployment.js';

// ── Global Settings ──
// GLOBAL SUDO = per-Telegram-user account setting (lives in each user's
// Settings hub). Applies to every session THIS Telegram account pairs.
// OMNI OWNER = BOT-WIDE platform layer (admin panel only). Applies to every
// session of every Telegram user. Both are never exposed in WhatsApp info.

export async function handleGlobalSudoPanel(ctx: Context & { telegramId: string }): Promise<void> {
  const { getGlobalSudoNumbers } = await import('../../services/workspace.js');
  const numbers = getGlobalSudoNumbers(ctx.telegramId);
  const text = [
    header('Global Sudo', 'G'),
    '',
    kv('Purpose:', 'Auto-sudo on every session'),
    kv('Scope:', 'This Telegram account'),
    kv('Count:', String(numbers.length)),
    '',
    ...(numbers.length > 0
      ? numbers.map((n, i) => `${i + 1}. <code>${H.code(n)}</code>`)
      : ['No Global Sudo numbers configured yet.']),
    '',
    noticeCard('Hint', 'Global Sudo applies to every session you pair and is hidden from normal session users.', 'success'),
  ].join('\n');
  const keyboard = permissionPanelKeyboard('globalsudo', numbers, 'settings:globalsudo');
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handleOmniOwnerPanel(ctx: Context & { telegramId: string }): Promise<void> {
  const { getOmniOwnerNumbers } = await import('../../services/workspace.js');
  const numbers = getOmniOwnerNumbers(ctx.telegramId);
  const text = [
    header('Omni Owner', 'O'),
    '',
    kv('Purpose:', 'Bypasses every permission check'),
    kv('Scope:', 'ALL sessions (bot-wide)'),
    kv('Count:', String(numbers.length)),
    '',
    ...(numbers.length > 0
      ? numbers.map((n, i) => `${i + 1}. <code>${H.code(n)}</code>`)
      : ['No Omni Owner configured yet.']),
    '',
    noticeCard('Hint', 'Omni Owner is the highest bot-wide layer — grants full access on every session of every Telegram user. Invisible to ordinary users.', 'success'),
  ].join('\n');
  const keyboard = permissionPanelKeyboard('omniowner', numbers, 'admin:panel');
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handlePermissionInput(
  ctx: Context & { telegramId: string },
  action: string,
  raw: string
): Promise<void> {
  const number = raw.replace(/\D/g, '');
  if (!number) {
    await ctx.reply(noticeCard('Invalid Number', 'Send a valid WhatsApp number (digits only, with country code).', 'warning'), { parse_mode: 'HTML' });
    return;
  }
  const isGlobalSudo = action.startsWith('gs-');
  const isAdd = action.endsWith('-add');
  const {
    addGlobalSudoNumbers,
    removeGlobalSudoNumbers,
    addOmniOwnerNumbers,
    removeOmniOwnerNumbers,
  } = await import('../../services/workspace.js');
  const next = isAdd
    ? (isGlobalSudo
      ? addGlobalSudoNumbers(ctx.telegramId, [number])
      : addOmniOwnerNumbers(undefined, [number]))
    : (isGlobalSudo
      ? removeGlobalSudoNumbers(ctx.telegramId, [number])
      : removeOmniOwnerNumbers(undefined, [number]));
  const label = isGlobalSudo ? 'Global Sudo' : 'Omni Owner';
  const scope = isGlobalSudo
    ? 'Applies to every session paired by this Telegram account; hidden from normal users.'
    : 'BOT-WIDE: applies to every session of every Telegram user; hidden from normal users.';
  const text = [
    header(isAdd ? 'Granted' : 'Revoked', isAdd ? '+' : '-'),
    '',
    kv('Layer:', label),
    kv('Number:', H.code(number)),
    kv('Total:', String(next.length)),
    '',
    noticeCard('Note', scope, 'success'),
  ].join('\n');
  const keyboard = backKeyboard(isGlobalSudo ? 'settings:globalsudo' : 'admin:omniowner');
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}


// ── Admin Panel ───────────────────────────────────────────

export async function handleAdminPanel(ctx: Context): Promise<void> {
  const sockets = getAllSockets();
  const users = getAllUserIds();

  const text = [
    header('Admin Control Panel', '👑'),
    '',
    kv('Active Sessions:', String(sockets.size)),
    kv('Total Users:', String(users.length)),
    kv('Platform:', '🟢 Online'),
  ].join('\n');

  const keyboard = adminPanelKeyboard(isGlobalPaused(), isMaintenanceMode());
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// ── User Management ───────────────────────────────────────

export async function handleAdminUsers(ctx: Context, page = 0): Promise<void> {
  const userIds = getAllUserIds();
  const { getAllSockets } = await import('../../whatsapp/socket-manager.js');
  const allSockets = getAllSockets();
  const users = userIds.map((id) => {
    const cfg = loadConfig(id);
    // Count active (non-frozen) sockets for this user
    const activeSessions = [...allSockets.entries()].filter(([, h]) => {
      const meta = h.meta as { telegramId?: string };
      return meta?.telegramId === id && !h.frozen;
    }).length;
    return { telegramId: id, username: cfg.username, isBanned: cfg.isBanned, activeSessions };
  });

  await ctx.editMessageText(
    `${header('User Management', '👥')}\n\n${H.italic(`${users.length} registered users`)}`,
    { parse_mode: 'HTML', reply_markup: adminUsersKeyboard(users, page) }
  ).catch(() => {});
}

export async function handleAdminUserMenu(ctx: Context, telegramId: string): Promise<void> {
  const cfg = loadConfig(telegramId);

  const text = [
    header(`User: ${cfg.username ?? telegramId}`, '🔍'),
    '',
    kv('Telegram ID:', H.code(telegramId)),
    kv('Status:', cfg.isBanned ? '🚫 Banned' : '✅ Active'),
    kv('Joined:', new Date(cfg.joinedAt).toLocaleDateString()),
    kv('Last Active:', new Date(cfg.lastActivity).toLocaleDateString()),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: adminUserKeyboard(telegramId, cfg.isBanned),
  }).catch(() => {});
}

export async function handleBanUser(
  ctx: Context,
  targetId: string,
  ban: boolean
): Promise<void> {
  updateConfig(targetId, { isBanned: ban });

  try {
    await ctx.telegram.sendMessage(
      parseInt(targetId, 10),
      ban
        ? '🚫 You have been banned from this bot.'
        : '✅ Your access has been restored.'
    );
  } catch {
    // User may have blocked the bot
  }

  await ctx.answerCbQuery(ban ? 'User banned' : 'User unbanned').catch(() => {});
  await handleAdminUserMenu(ctx, targetId);
}

// ── Inspect Workspace ─────────────────────────────────────

export async function handleInspectUser(ctx: Context & { telegramId?: string }, targetId: string): Promise<void> {
  const cfg = loadConfig(targetId);
  const main = loadBucket(targetId, 'main');
  const active = loadBucket(targetId, 'active');
  const dead = loadBucket(targetId, 'dead');
  const { loadAllSessions } = await import('../../services/workspace.js');
  const sessions = Object.values(loadAllSessions(targetId));

  const text = [
    header(`Workspace: ${cfg.username ?? targetId}`, '🔍'),
    '',
    kv('Telegram ID:', H.code(targetId)),
    kv('Main Bucket:', String(main.length)),
    kv('Active Bucket:', String(active.length)),
    kv('Dead Bucket:', String(dead.length)),
    kv('Prefix:', cfg.prefix || 'null'),
    kv('Sessions:', String(sessions.length)),
  ].join('\n');

  const sessionButtons = sessions.map((s) => {
    const icon = { ACTIVE: '🟢', FROZEN: '❄️', PAIRING: '🟡', PURGED: '🔴' }[s.status as string] ?? '⚪';
    return [{ text: `${icon} ${s.label ?? s.phone}`, callback_data: `session:${s.sessionId}:menu` }];
  });

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        ...sessionButtons,
        [{ text: '🔙 Back', callback_data: `admin:user:${targetId}` }],
      ],
    },
  }).catch(() => {});
}

// ── Purge User Sessions ───────────────────────────────────

export async function handlePurgeUserSessions(
  ctx: Context,
  targetId: string
): Promise<void> {
  await ctx.editMessageText(
    `${header('Confirm: Purge All Sessions', '⚠️')}\n\nThis will delete ALL sessions for user ${H.code(targetId)}.`,
    {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard(
        `admin:purge_confirm:${targetId}`,
        `admin:user:${targetId}`
      ),
    }
  ).catch(() => {});
}

export async function handlePurgeConfirm(ctx: Context, targetId: string): Promise<void> {
  purgeAllSessions(targetId);
  await ctx.answerCbQuery('Sessions purged').catch(() => {});
  await ctx.editMessageText(
    `${header('Purged', '🗑')}\n\nAll sessions for ${H.code(targetId)} have been deleted.`,
    { parse_mode: 'HTML', reply_markup: backKeyboard('admin:users:0') }
  ).catch(() => {});
}

// ── Master Bucket ─────────────────────────────────────────

export async function handleMasterBucket(ctx: Context): Promise<void> {
  const userIds = getAllUserIds();
  const master = getMasterActiveBucket(userIds);

  const text = [
    header('Master Active Bucket', '🌐'),
    '',
    kv('Total Links:', String(master.length)),
    kv('From Users:', String(userIds.length)),
    '',
    H.blockquote(`Aggregates all Active bucket links from every user workspace.`),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📤 Export TXT', callback_data: 'admin:master:export:txt', style: 'primary' }],
        ...backKeyboard('admin:panel').inline_keyboard,
      ],
    } as never,
  }).catch(() => {});
}

// ── Omni-Bridge ───────────────────────────────────────────

export async function handleOmniBridge(ctx: Context & { telegramId: string }): Promise<void> {
  const allSockets = getAllSockets();
  const count = [...allSockets.values()].filter((h) => !h.frozen).length;
  await ctx.editMessageText(
    [
      header('Omni-Bridge', '📡'),
      '',
      `<b>Connected sessions (platform-wide):</b> ${count}`,
      '',
      H.blockquote(
        'Runs any WhatsApp command on ALL connected sessions across the entire platform.\n\n' +
        'Uses a fixed <code>.</code> prefix — works regardless of each session\'s configured prefix.\n\n' +
        'Long-running commands (allstatus, joinall, etc.) show a live log per session.\n\n' +
        'Examples:\n• .ping\n• .menu\n• .allstatus hello\n• .info'
      ),
      '',
      'Tap <b>Send Command</b> to open the input prompt.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [{ text: '📡 Send Omni Command', callback_data: 'admin:omni:input' }],
      [{ text: '🔙 Back', callback_data: 'admin:panel' }],
    ]} }
  ).catch(() => {});
}

export async function executeOmniCommand(
  ctx: Context & { telegramId: string; chat?: { id: number } },
  command: string,
  _unused: string
): Promise<void> {
  const { getAllSockets, getSocket, isFrozen } = await import('../../whatsapp/socket-manager.js');
  const { executeBridgeCommand } = await import('../../whatsapp/event-handlers.js');
  const { findSessionOwner } = await import('../../services/workspace.js');

  const allSockets = getAllSockets();
  const sessionIds = [...allSockets.keys()].filter((sid) => {
    const h = allSockets.get(sid);
    return h && !h.frozen;
  });

  if (sessionIds.length === 0) {
    await ctx.reply(noticeCard('No Active Sessions', 'No connected WhatsApp sessions found across the platform.', 'warning'), { parse_mode: 'HTML' });
    return;
  }

  // Normalize command: always use dot prefix regardless of session config
  const normalizedCmd = command.startsWith('.') ? command : `.${command.replace(/^[^a-zA-Z0-9]/, '')}`;

  const chatId = ctx.chat!.id;

  // Send one header message
  await ctx.reply(
    `${header('Omni-Bridge Running', '📡')}\n\n<blockquote>Command: <code>${escape(normalizedCmd)}</code>\nSessions: ${sessionIds.length}\n\nEach session result will appear below…</blockquote>`,
    { parse_mode: 'HTML' }
  );

  // Run each session independently — send its own live-updating message
  await Promise.allSettled(
    sessionIds.map(async (sid) => {
      const socket = getSocket(sid);
      if (!socket || isFrozen(sid)) {
        await ctx.telegram.sendMessage(chatId,
          `${header(`❌ ${sid.split('_').pop() ?? sid}`, '📡')}\n\n<blockquote>Session unavailable</blockquote>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
      }
      const ownerTelegramId = findSessionOwner(sid) ?? ctx.telegramId;
      const shortId = sid.split('_').pop() ?? sid;

      // Send initial per-session message
      let msgId: number | null = null;
      try {
        const sent = await ctx.telegram.sendMessage(chatId,
          `${header(`📡 ${shortId}`, '⏳')}\n\n<blockquote expandable>Running…</blockquote>`,
          { parse_mode: 'HTML' }
        );
        msgId = sent.message_id;
      } catch { return; }

      const lines: string[] = [];
      let lastEdit = 0;

      const flush = async (final = false): Promise<void> => {
        const now = Date.now();
        if (!final && now - lastEdit < 2000) return;
        lastEdit = now;
        const body = lines.join('\n').slice(0, 900) || '✅ Done';
        const text = `${header(`📡 ${shortId}`, final ? '✅' : '⏳')}\n\n<blockquote expandable>${escape(body)}</blockquote>`;
        await ctx.telegram.editMessageText(chatId, msgId!, undefined, text, { parse_mode: 'HTML' }).catch(() => {});
      };

      try {
        await executeBridgeCommand(sid, ownerTelegramId, normalizedCmd, socket, async (r) => {
          if (r) { lines.push(r); await flush(); }
        }, { forcePrefix: '.' });
        await flush(true);
      } catch (err) {
        lines.push(`Error: ${String(err).slice(0, 200)}`);
        await flush(true);
      }
    })
  );

  await ctx.reply(
    `${header('Omni-Bridge Complete', '📡')}\n\n<blockquote>All ${sessionIds.length} session(s) processed.</blockquote>`,
    { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') }
  ).catch(() => {});
}

export async function handleGlobalPause(ctx: Context, paused: boolean): Promise<void> {
  setGlobalPause(paused);
  await ctx.answerCbQuery(paused ? 'Global pause ON' : 'Global pause OFF').catch(() => {});
  await ctx.editMessageText(
    `${header('Global Pause', paused ? '⏸' : '▶️')}\n\nAll user traffic is ${paused ? H.bold('PAUSED') : H.bold('RESUMED')}.`,
    { parse_mode: 'HTML', reply_markup: adminPanelKeyboard(paused, isMaintenanceMode()) }
  ).catch(() => {});
}

export async function handleMaintenanceToggle(ctx: Context, enabled: boolean): Promise<void> {
  setMaintenanceMode(enabled);
  await ctx.answerCbQuery(enabled ? 'Maintenance ON' : 'Maintenance OFF').catch(() => {});
  await ctx.editMessageText(
    `${header('Maintenance Mode', enabled ? '🔧' : '✅')}\n\n${enabled ? 'Bot is now in maintenance mode.' : 'Bot is back online.'}`,
    { parse_mode: 'HTML', reply_markup: adminPanelKeyboard(isGlobalPaused(), enabled) }
  ).catch(() => {});
}

// ── Platform Stats ────────────────────────────────────────

export async function handlePlatformStats(ctx: Context): Promise<void> {
  const userIds = getAllUserIds();
  const master = getMasterActiveBucket(userIds);
  const { loadAllSessions } = await import('../../services/workspace.js');

  let active = 0;
  let pairing = 0;
  let frozen = 0;
  let purged = 0;

  for (const id of userIds) {
    const sessions = Object.values(loadAllSessions(id));
    for (const s of sessions) {
      if (s.status === 'ACTIVE') active++;
      else if (s.status === 'PAIRING') pairing++;
      else if (s.status === 'FROZEN') frozen++;
      else if (s.status === 'PURGED') purged++;
    }
  }

  const text = [
    header('Platform Statistics', '📊'),
    '',
    kv('Total Users:', String(userIds.length)),
    '',
    kv('🟢 Active:', String(active)),
    kv('🟡 Pairing:', String(pairing)),
    kv('❄️ Frozen:', String(frozen)),
    kv('🔴 Purged:', String(purged)),
    '',
    kv('Master Active Links:', String(master.length)),
    kv('Uptime:', humanUptime()),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🗑 Clear Dead Sessions', callback_data: 'admin:clear:dead' }],
        [{ text: '🧨 Clear All Sessions', callback_data: 'admin:clear:all:confirm' }],
        [{ text: '🔙 Back', callback_data: 'admin:panel' }],
      ],
    },
  }).catch(() => {});
}

export async function handleClearDeadSessions(ctx: Context): Promise<void> {
  const userIds = getAllUserIds();
  const { loadAllSessions, purgeSession } = await import('../../services/workspace.js');
  let count = 0;

  for (const id of userIds) {
    const sessions = Object.values(loadAllSessions(id));
    for (const s of sessions) {
      if (s.status === 'PURGED') {
        await purgeSession(id, s.sessionId);
        count++;
      }
    }
  }

  await ctx.answerCbQuery(`Cleared ${count} dead sessions`).catch(() => {});
  await handlePlatformStats(ctx);
}

export async function handleClearAllSessionsConfirm(ctx: Context): Promise<void> {
  await ctx.editMessageText(
    `${header('Confirm: Clear ALL Sessions', '⚠️')}\n\nThis will delete EVERY session on the entire platform. This cannot be undone.`,
    {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard(
        'admin:clear:all:execute',
        'admin:stats'
      ),
    }
  ).catch(() => {});
}

export async function handleClearAllSessionsExecute(ctx: Context): Promise<void> {
  const userIds = getAllUserIds();
  const { loadAllSessions, purgeSession } = await import('../../services/workspace.js');
  let count = 0;

  for (const id of userIds) {
    const sessions = Object.values(loadAllSessions(id));
    for (const s of sessions) {
      await purgeSession(id, s.sessionId);
      count++;
    }
  }

  await ctx.answerCbQuery(`Cleared ${count} sessions`).catch(() => {});
  await handlePlatformStats(ctx);
}

function humanUptime(): string {
  const ms = process.uptime() * 1000;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

// ── Update Bot ────────────────────────────────────────────

// Track active deployments to prevent concurrent runs
const activeDeployments = new Set<string>();

export async function handleReleaseMenu(ctx: any): Promise<void> {
  const cfg = loadPlatformConfig();

  const text = [
    header('Release Notification Settings', '📢'),
    '',
    kv('Channel Username:', cfg.releaseChannelUsername ? H.code(cfg.releaseChannelUsername) : H.italic('Not set')),
    kv('Auto-Post:', cfg.releasePostsEnabled ? '✅ Enabled' : '🚫 Disabled'),
    '',
    H.blockquote('Release notes will be automatically posted to this channel after a successful update.'),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [btn('✏️ Set Username', 'admin:release:setuser', 'primary')],
        [cfg.releasePostsEnabled
          ? btn('🚫 Disable Auto-Post', 'admin:release:toggle:off', 'danger')
          : btn('✅ Enable Auto-Post', 'admin:release:toggle:on', 'success')],
        [btn('🔙 Back', 'admin:panel', 'primary')],
      ],
    },
  }).catch(() => {});
}

export async function handleReleaseToggle(ctx: any, enabled: boolean): Promise<void> {
  updatePlatformConfig({ releasePostsEnabled: enabled });
  await ctx.answerCbQuery(enabled ? 'Auto-post enabled' : 'Auto-post disabled').catch(() => {});
  await handleReleaseMenu(ctx);
}

export async function handleSetReleaseUsername(ctx: any): Promise<void> {
  ctx.session.awaitingReleaseUsername = true;
  await ctx.editMessageText(
    card('Set Release Channel', '📢', [], 'Send the public Telegram channel username (e.g., @PappyUpdates).'),
    { parse_mode: 'HTML', reply_markup: backKeyboard('admin:release:menu') }
  ).catch(() => {});
}

export async function processReleaseUsername(ctx: Context & { session: any; telegramId: string }): Promise<void> {
  if (!ctx.session.awaitingReleaseUsername) return;
  delete ctx.session.awaitingReleaseUsername;

  const text = (ctx.message as any).text?.trim();
  if (!text || !text.startsWith('@')) {
    await ctx.reply(noticeCard('Invalid Username', 'Username must start with @', 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard('admin:release:menu') });
    return;
  }

  // Verify username resolution
  try {
    const chat = await ctx.telegram.getChat(text);
    if (chat.type !== 'channel') {
      await ctx.reply(noticeCard('Invalid Chat', 'The provided username must belong to a public channel.', 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard('admin:release:menu') });
      return;
    }
    
    updatePlatformConfig({ releaseChannelUsername: text });
    await ctx.reply(noticeCard('Release Channel Updated', `Release notes will be posted to ${H.code(text)}`, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard('admin:release:menu') });
  } catch (err) {
    await ctx.reply(noticeCard('Resolution Failed', `Could not find channel ${text}. Make sure the bot is an admin in the channel.`, 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard('admin:release:menu') });
  }
}

export async function handleUpdateBot(ctx: Context & { telegramId: string }): Promise<void> {
  if (activeDeployments.has(ctx.telegramId)) {
    await ctx.answerCbQuery('A deployment is already in progress', { show_alert: true }).catch(() => {});
    return;
  }

  activeDeployments.add(ctx.telegramId);
  await ctx.answerCbQuery('Deployment started').catch(() => {});

  // ONE live message only — the console is created here and progressively
  // edited by onProgress until it becomes the final summary. No separate
  // "Deployment Running" message (the old flow sent two live logs).
  let msgId: number;
  try {
    const sent = await ctx.telegram.sendMessage(
      parseInt(ctx.telegramId, 10),
      `${header('Live Deploy Console', '\ud83d\ude80')}\n\n<blockquote expandable>\u23f3 Starting...</blockquote>`,
      { parse_mode: 'HTML' }
    );
    msgId = sent.message_id;
  } catch (err) {
    activeDeployments.delete(ctx.telegramId);
    logger.error('[Deploy] Could not send console message', { err: String(err) });
    return;
  }

  const onProgress = async (lines: string[]): Promise<void> => {
    // Last 60 lines in expandable blockquote for real terminal feel
    const logLines = lines.slice(-60).join('\n');
    const text = [
      `${header('Live Deploy Console', '\ud83d\ude80')}`,
      '',
      `<blockquote expandable>${logLines}</blockquote>`,
    ].join('\n');
    await ctx.telegram.editMessageText(
      parseInt(ctx.telegramId, 10),
      msgId,
      undefined,
      text.slice(0, 4096),
      { parse_mode: 'HTML' }
    ).catch(() => {});
  };

  try {
    const result = await runDeployment(onProgress);

    if (result.success) {
      const summary = [
        `${header('Deployment Complete', '\u2705')}`,
        '',
        kv('Prev commit:', H.code(result.prevCommit ?? 'unknown')),
        kv('New commit:', H.code(result.currCommit ?? 'unknown')),
        kv('Files changed:', String(result.filesChanged ?? 0)),
        kv('Build time:', `${((result.buildDurationMs ?? 0) / 1000).toFixed(1)}s`),
        kv('Total time:', `${((result.totalDurationMs ?? 0) / 1000).toFixed(1)}s`),
        kv('Status:', '\ud83d\udfe2 Online'),
      ].join('\n');
      await ctx.telegram.editMessageText(
        parseInt(ctx.telegramId, 10), msgId, undefined, summary,
        { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') }
      ).catch(() => {});
    } else {
      const isRollback = result.prevCommit && result.error?.includes('ROLLBACK');
      const failMsg = [
        `${header('Deployment Failed', '\u274c')}`,
        '',
        kv('Step:', H.bold(result.failedStep ?? 'Unknown')),
        '',
        `<blockquote expandable>${H.pre((result.error ?? 'No details').slice(0, 1000), 'log')}</blockquote>`,
        '',
        isRollback 
          ? H.italic('❌ Critical: Deployment failed and rollback failed.') 
          : H.italic(result.prevCommit ? '🔄 Rolled back to previous version.' : '⚠️ Fresh install failed. No version running.'),
      ].join('\n');
      await ctx.telegram.editMessageText(
        parseInt(ctx.telegramId, 10), msgId, undefined, failMsg,
        { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') }
      ).catch(() => {});
    }
  } finally {
    activeDeployments.delete(ctx.telegramId);
  }
}

// ── Live Log Stream ──────────────────────────────────────

const activeLogStreams = new Map<string, () => void>();

export async function handleLogStream(ctx: Context & { telegramId: string }): Promise<void> {
  // Stop existing stream if any
  activeLogStreams.get(ctx.telegramId)?.();

  await ctx.answerCbQuery('Opening log stream…').catch(() => {});

  let msgId: number;
  try {
    const sent = await ctx.telegram.sendMessage(
      parseInt(ctx.telegramId, 10),
      `${header('Live Log Stream', '📋')}\n\n<blockquote expandable>⏳ Connecting to pm2 logs…</blockquote>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⏹ Stop Stream', callback_data: 'admin:logs:stop' }]] } }
    );
    msgId = sent.message_id;
  } catch { return; }

  const lines: string[] = [];
  let lastEdit = 0;
  let editTimer: ReturnType<typeof setTimeout> | null = null;

  const pushEdit = () => {
    const now = Date.now();
    if (now - lastEdit < 1000) {
      if (!editTimer) editTimer = setTimeout(pushEdit, 1000 - (now - lastEdit));
      return;
    }
    editTimer = null;
    lastEdit = now;
    const logText = lines.slice(-80).join('\n') || '(no output)';
    const text = `${header('Live Log Stream', '📋')}\n\n<blockquote expandable>${logText}</blockquote>`;
    ctx.telegram.editMessageText(
      parseInt(ctx.telegramId, 10), msgId, undefined,
      text.slice(0, 4096),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⏹ Stop Stream', callback_data: 'admin:logs:stop' }]] } }
    ).catch(() => {});
  };

  const { spawn } = await import('child_process');
  const proc = spawn('pm2', ['logs', 'wa-bridge', '--lines', '30', '--no-color'], { env: process.env });
  let buf = '';

  const onData = (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const l of parts) {
      const clean = l.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (clean) lines.push(clean);
    }
    pushEdit();
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  const stop = () => {
    proc.kill();
    if (editTimer) clearTimeout(editTimer);
    activeLogStreams.delete(ctx.telegramId);
    const logText = lines.slice(-80).join('\n') || '(no output)';
    ctx.telegram.editMessageText(
      parseInt(ctx.telegramId, 10), msgId, undefined,
      `${header('Log Stream Stopped', '⏹')}\n\n<blockquote expandable>${logText}</blockquote>`.slice(0, 4096),
      { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') }
    ).catch(() => {});
  };

  activeLogStreams.set(ctx.telegramId, stop);

  // Auto-stop after 5 minutes
  setTimeout(() => { if (activeLogStreams.has(ctx.telegramId)) stop(); }, 5 * 60 * 1000);
}

export function stopLogStream(telegramId: string): void {
  activeLogStreams.get(telegramId)?.();
}

// ── Restart Bot ────────────────────────────────────────────

export async function handleRestartBot(ctx: Context & { telegramId: string }): Promise<void> {
  await ctx.answerCbQuery('Building & Restarting…').catch(() => {});

  let msgId: number;
  try {
    const sent = await ctx.telegram.sendMessage(
      parseInt(ctx.telegramId, 10),
      `${header('Build & Restart', '🔄')}\n\n<blockquote expandable>\u23f3 Running npm run build\u2026</blockquote>`,
      { parse_mode: 'HTML' }
    );
    msgId = sent.message_id;
  } catch {
    msgId = 0;
  }

  await ctx.editMessageText(
    `${header('Build & Restart Started', '🔄')}\n\nBuilding then restarting. Check the message above for live output.`,
    { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') }
  ).catch(() => {});

  const { exec } = await import('child_process');
  const chatId = parseInt(ctx.telegramId, 10);

  const edit = async (text: string, final = false): Promise<void> => {
    if (!msgId) return;
    const body = `${header('Build & Restart', final ? '\u2705' : '🔄')}\n\n<blockquote expandable>${text.slice(0, 3800)}</blockquote>`;
    await ctx.telegram.editMessageText(chatId, msgId, undefined, body, {
      parse_mode: 'HTML',
      ...(final ? { reply_markup: backKeyboard('admin:panel') } : {}),
    }).catch(() => {});
  };

  // Run build first, stream output
  const buildProc = exec('npm run build --prefix /root/omega-v1/artifacts/wa-bridge 2>&1');
  const lines: string[] = [];
  let lastEdit = Date.now();

  const onData = (d: Buffer | string): void => {
    const chunk = d.toString();
    lines.push(...chunk.split('\n').filter(Boolean));
    const now = Date.now();
    if (now - lastEdit > 1500) {
      lastEdit = now;
      edit(lines.slice(-40).join('\n')).catch(() => {});
    }
  };

  buildProc.stdout?.on('data', onData);
  buildProc.stderr?.on('data', onData);

  buildProc.on('close', (code) => {
    if (code !== 0) {
      lines.push(`\n\u274c Build failed (exit ${code}). Not restarting.`);
      edit(lines.slice(-40).join('\n'), true).catch(() => {});
      return;
    }
    lines.push('\n\u2705 Build complete. Restarting via PM2\u2026');
    edit(lines.slice(-40).join('\n')).catch(() => {});
    // Small delay so Telegram gets the edit before process dies
    setTimeout(() => {
      exec('pm2 restart wa-bridge --update-env', (err) => {
        if (err) logger.error('[Admin] Restart failed', { err: String(err) });
      });
    }, 800);
  });
}

// ── Global Menu URL Manager ──────────────────────────────

import { getGlobalMenuButtons, saveGlobalMenuButtons } from '../../services/workspace.js';
import { adminMenuUrlManagerKeyboard, adminMenuUrlEditKeyboard } from '../ui/keyboards.js';

export async function handleAdminMenuUrlManager(ctx: Context): Promise<void> {
  const buttons = getGlobalMenuButtons();
  const text = [
    header('Global Menu URL Manager', '🔗'),
    '',
    H.blockquote('Configure buttons that appear automatically on all bot responses.'),
    '',
    buttons.length === 0 ? H.italic('No buttons configured.') : `<b>${buttons.length} buttons configured:</b>`,
  ].join('\n');

  const keyboard = adminMenuUrlManagerKeyboard(buttons);
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handleAdminMenuUrlEdit(ctx: Context, buttonId: string): Promise<void> {
  const buttons = getGlobalMenuButtons();
  const button = buttons.find((b) => b.id === buttonId);
  if (!button) {
    await ctx.answerCbQuery('Button not found').catch(() => {});
    return handleAdminMenuUrlManager(ctx);
  }

  const text = [
    header('Edit Menu Button', '✏️'),
    '',
    kv('Name:', button.name),
    kv('URL:', H.code(button.url)),
    kv('Status:', button.enabled ? '✅ Enabled' : '❌ Disabled'),
    kv('Order:', String(button.order)),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: adminMenuUrlEditKeyboard(buttonId, button.enabled),
  }).catch(() => {});
}

export async function handleAdminMenuUrlToggle(ctx: Context, buttonId: string): Promise<void> {
  const buttons = getGlobalMenuButtons();
  const button = buttons.find((b) => b.id === buttonId);
  if (button) {
    button.enabled = !button.enabled;
    saveGlobalMenuButtons(buttons);
    await ctx.answerCbQuery(button.enabled ? 'Button enabled' : 'Button disabled').catch(() => {});
  }
  await handleAdminMenuUrlEdit(ctx, buttonId);
}

export async function handleAdminMenuUrlDelete(ctx: Context, buttonId: string): Promise<void> {
  let buttons = getGlobalMenuButtons();
  buttons = buttons.filter((b) => b.id !== buttonId);
  // Re-index orders
  buttons.forEach((b, i) => { b.order = i; });
  saveGlobalMenuButtons(buttons);
  await ctx.answerCbQuery('Button deleted').catch(() => {});
  await handleAdminMenuUrlManager(ctx);
}

export async function handleAdminMenuUrlMove(ctx: Context, buttonId: string, direction: 'up' | 'down'): Promise<void> {
  const buttons = getGlobalMenuButtons();
  const index = buttons.findIndex((b) => b.id === buttonId);
  if (index === -1) return;

  if (direction === 'up' && index > 0) {
    const prev = buttons[index - 1]!;
    const curr = buttons[index]!;
    const tempOrder = prev.order;
    prev.order = curr.order;
    curr.order = tempOrder;
  } else if (direction === 'down' && index < buttons.length - 1) {
    const next = buttons[index + 1]!;
    const curr = buttons[index]!;
    const tempOrder = next.order;
    next.order = curr.order;
    curr.order = tempOrder;
  }

  saveGlobalMenuButtons(buttons);
  await handleAdminMenuUrlManager(ctx);
}

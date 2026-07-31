// ============================================================
// WA-Bridge — Admin Panel Telegram Handlers
// Platform governance, omni-bridge, master bucket, etc.
// ============================================================

import type { Context } from 'telegraf';
import { loadConfig, updateConfig, purgeAllSessions, loadBucket, getAllUserIds } from '../../services/workspace.js';
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
  confirmKeyboard,
  backKeyboard,
} from '../ui/keyboards.js';
import { header, H, kv, bucketCard, noticeCard, escape } from '../../utils/formatter.js';
import { logger } from '../../utils/logger.js';
import { runDeployment } from '../../services/deployment.js';

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
  const users = userIds.map((id) => {
    const cfg = loadConfig(id);
    return { telegramId: id, username: cfg.username, isBanned: cfg.isBanned };
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
    const icon = { open: '🟢', frozen: '🔵', error: '🔴', connecting: '🟡', closed: '⚫', banned: '💀' }[s.status] ?? '⚪';
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
  const sockets = getAllSockets();
  const userIds = getAllUserIds();
  const master = getMasterActiveBucket(userIds);

  let totalActive = 0;
  let totalFrozen = 0;
  for (const [, h] of sockets.entries()) {
    if (h.frozen) totalFrozen++;
    else totalActive++;
  }

  const text = [
    header('Platform Statistics', '📊'),
    '',
    kv('Total Users:', String(userIds.length)),
    kv('Active Sessions:', String(totalActive)),
    kv('Frozen Sessions:', String(totalFrozen)),
    kv('Master Active Links:', String(master.length)),
    kv('Uptime:', humanUptime()),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: backKeyboard('admin:panel'),
  }).catch(() => {});
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

export async function handleUpdateBot(ctx: Context & { telegramId: string }): Promise<void> {
  if (activeDeployments.has(ctx.telegramId)) {
    await ctx.answerCbQuery('A deployment is already in progress', { show_alert: true }).catch(() => {});
    return;
  }

  activeDeployments.add(ctx.telegramId);
  await ctx.answerCbQuery('Deployment started').catch(() => {});
  await ctx.editMessageText(
    `${header('Deployment Running', '\ud83d\udd04')}\n\nLive console opened below.`,
    { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') }
  ).catch(() => {});

  // Send initial console message
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
      const failMsg = [
        `${header('Deployment Failed', '\u274c')}`,
        '',
        kv('Step:', H.bold(result.failedStep ?? 'Unknown')),
        '',
        `<blockquote expandable>${H.pre((result.error ?? 'No details').slice(0, 800), 'log')}</blockquote>`,
        '',
        H.italic('Previous version still running.'),
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
  await ctx.answerCbQuery('Restarting…').catch(() => {});
  await ctx.editMessageText(
    `${header('Restarting…', '🔁')}\n\nPM2 is restarting the bot. You will receive a startup message in a few seconds.`,
    { parse_mode: 'HTML', reply_markup: backKeyboard('admin:panel') }
  ).catch(() => {});
  // Delay slightly so Telegram gets the response before the process dies
  setTimeout(() => {
    import('child_process').then(({ exec }) => {
      exec('pm2 restart wa-bridge --update-env', (err) => {
        if (err) logger.error('[Admin] Restart failed', { err: String(err) });
      });
    }).catch(() => {});
  }, 800);
}

// ============================================================
// WA-Bridge — Bucket Management Telegram Handlers
// Tri-bucket validator UI: view, filter, export, purge
// Live validator dashboard with session failover
// ============================================================

import type { Context } from 'telegraf';
import fs from 'fs';
import path from 'path';
import {
  loadBucket,
  saveBucket,
  addToMainBucket,
  getAllUserIds,
} from '../../services/workspace.js';
import {
  isAutoFilterRunning,
  stopAutoFilter,
  startAutoFilter,
  exportBucket,
  extractAllInviteLinks,
} from '../../services/tri-bucket.js';
import { enqueueJob } from '../../services/queue.js';
import {
  bucketMenuKeyboard,
  bucketViewKeyboard,
} from '../ui/keyboards.js';
import { header, H, bucketCard, kv, card, noticeCard, escape } from '../../utils/formatter.js';
import { logger } from '../../utils/logger.js';
import { getSocket, getUserSockets } from '../../whatsapp/socket-manager.js';

// ── Bucket Status ─────────────────────────────────────────

export async function handleBucketStatus(ctx: Context & { telegramId: string }): Promise<void> {
  const main = loadBucket(ctx.telegramId, 'main');
  const active = loadBucket(ctx.telegramId, 'active');
  const dead = loadBucket(ctx.telegramId, 'dead');
  const filterRunning = isAutoFilterRunning(ctx.telegramId);

  const text = bucketCard({
    main: main.length,
    active: active.length,
    dead: dead.length,
    filterActive: filterRunning,
  });

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: bucketMenuKeyboard(filterRunning),
    }).catch(() => {});
  } else {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: bucketMenuKeyboard(filterRunning),
    });
  }
}

// ── Bucket View ───────────────────────────────────────────

export async function handleBucketView(
  ctx: Context & { telegramId: string },
  bucket: 'main' | 'active' | 'dead',
  page = 0
): Promise<void> {
  const entries = loadBucket(ctx.telegramId, bucket);
  const pageSize = 15;
  const start = page * pageSize;
  const slice = entries.slice(start, start + pageSize);

  const emoji = { main: '📥', active: '✅', dead: '💀' }[bucket];

  const linkList = slice
    .map((e, i) => `${start + i + 1}. ${e.title ? H.bold(e.title) + '\n   ' : ''}${H.code(e.link)}`)
    .join('\n\n');

  const text = [
    card(`${bucket.toUpperCase()} Bucket`, emoji, [
      ['Showing', entries.length ? `${start + 1}–${Math.min(start + pageSize, entries.length)}` : '0'],
      ['Total', String(entries.length)],
    ], entries.length ? 'Open the expandable list to review links.' : 'This bucket is empty.'),
    linkList ? H.blockquote(linkList, true) : '',
  ].filter(Boolean).join('\n\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: bucketViewKeyboard(bucket, page, entries.length, pageSize),
  }).catch(() => {});
}

// ── Add Links ─────────────────────────────────────────────

export async function handleAddLinks(
  ctx: Context & { telegramId: string },
  rawText: string
): Promise<void> {
  // Use the enhanced extractor that handles any embedded content
  const links = extractAllInviteLinks(rawText);

  if (links.length === 0) {
    await ctx.reply(
      noticeCard('No Links Found', 'Send one or more valid WhatsApp group invite links.', 'warning', 'https://chat.whatsapp.com/...'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  const { added, dupes } = addToMainBucket(ctx.telegramId, links);
  const main = loadBucket(ctx.telegramId, 'main');

  await ctx.reply(
    card('Links Added', '📥', [
      ['Added', String(added)],
      ['Duplicates skipped', String(dupes)],
      ['Main bucket total', String(main.length)],
    ], 'Use Start Filter to validate pending links.'),
    { parse_mode: 'HTML', reply_markup: bucketMenuKeyboard(isAutoFilterRunning(ctx.telegramId)) }
  );
}

// ── Start / Stop Auto-Filter ──────────────────────────────

export async function handleStartFilter(ctx: Context & { telegramId: string }): Promise<void> {
  if (isAutoFilterRunning(ctx.telegramId)) {
    await ctx.answerCbQuery('Filter already running').catch(() => {});
    return;
  }

  const sessionIds = getUserSockets(ctx.telegramId);
  if (sessionIds.length === 0) {
    await ctx.answerCbQuery('No active sessions — connect WhatsApp first', { show_alert: true }).catch(() => {});
    return;
  }

  const primarySessionId = sessionIds[0]!;
  const primarySocket = getSocket(primarySessionId);
  if (!primarySocket) {
    await ctx.answerCbQuery('Socket not ready', { show_alert: true }).catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Validator started').catch(() => {});

  const main = loadBucket(ctx.telegramId, 'main');
  const pending = main.filter((e) => e.status === 'unvalidated').length;

  // Send the initial dashboard shell
  const progressMsg = await ctx.reply(
    [
      `<blockquote>`,
      `<b>◈ OMEGA VALIDATOR</b>`,
      ``,
      `Queue      ${pending.toLocaleString('en-US')}`,
      `Live       0`,
      `Dead       0`,
      `Pending    ${pending.toLocaleString('en-US')}`,
      ``,
      `Session    #01`,
      `Status     ● STARTING`,
      `Speed      0.0 links/min`,
      `</blockquote>`,
    ].join('\n'),
    { parse_mode: 'HTML' }
  );

  const chatId = ctx.chat!.id;
  const msgId = progressMsg.message_id;

  // Session failover: returns next healthy session
  const usedSessions = new Set<string>([primarySessionId]);
  const getAlternativeSocket = (_currentId: string): { socket: import('../../whatsapp/baileys-types.js').BridgeWASocket; sessionId: string } | null => {
    for (const sid of sessionIds) {
      if (!usedSessions.has(sid)) {
        const alt = getSocket(sid);
        if (alt) {
          usedSessions.add(sid);
          return { socket: alt, sessionId: sid };
        }
      }
    }
    return null;
  };

  // Progress callback: edit the existing dashboard message (HTML — do NOT escape)
  const onProgress = async (html: string): Promise<void> => {
    try {
      await ctx.telegram.editMessageText(chatId, msgId, undefined, html, { parse_mode: 'HTML' });
    } catch {
      // Edit window expired or message deleted — ignore
    }
  };

  startAutoFilter(
    ctx.telegramId,
    primarySessionId,
    primarySocket,
    onProgress,
    getAlternativeSocket
  ).then(async () => {
    const active = loadBucket(ctx.telegramId, 'active');
    const dead = loadBucket(ctx.telegramId, 'dead');
    // Final summary card
    await ctx.reply(
      card('Validator Complete', '✅', [
        ['Active', String(active.length)],
        ['Dead', String(dead.length)],
      ], 'Review or export the validated active bucket.'),
      { parse_mode: 'HTML', reply_markup: bucketMenuKeyboard(false) }
    );
  }).catch(logger.error.bind(logger));
}

export async function handleStopFilter(ctx: Context & { telegramId: string }): Promise<void> {
  stopAutoFilter(ctx.telegramId);
  await ctx.answerCbQuery('Filter stopped').catch(() => {});
  await handleBucketStatus(ctx);
}

// ── Export Bucket ─────────────────────────────────────────

export async function handleExportBucket(
  ctx: Context & { telegramId: string },
  format: 'txt' | 'csv' | 'html'
): Promise<void> {
  const active = loadBucket(ctx.telegramId, 'active');
  if (active.length === 0) {
    await ctx.answerCbQuery('Active bucket is empty').catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Generating export…').catch(() => {});

  try {
    const filepath = exportBucket(ctx.telegramId, 'active', format);
    const filename = path.basename(filepath);
    const source = { source: fs.createReadStream(filepath), filename };

    if (format === 'txt' || format === 'csv') {
      await ctx.replyWithDocument(source, {
        caption: `✅ Active bucket export — ${active.length} links`,
      });
    } else {
      await ctx.replyWithDocument(source, {
        caption: `🌐 Active bucket HTML export — ${active.length} links`,
      });
    }
  } catch (err) {
    await ctx.reply(noticeCard('Export Failed', 'The active bucket could not be exported.', 'error', String(err)), { parse_mode: 'HTML' });
  }
}

// ── Purge Dead Bucket ─────────────────────────────────────

export async function handlePurgeDead(ctx: Context & { telegramId: string }): Promise<void> {
  const dead = loadBucket(ctx.telegramId, 'dead');
  const count = dead.length;
  saveBucket(ctx.telegramId, 'dead', []);

  await ctx.answerCbQuery(`Purged ${count} dead links`).catch(() => {});
  await handleBucketStatus(ctx);
}

// ── Merge Buckets ─────────────────────────────────────────

export async function handleMergeBuckets(ctx: Context & { telegramId: string }): Promise<void> {
  const main = loadBucket(ctx.telegramId, 'main');
  const active = loadBucket(ctx.telegramId, 'active');

  // Merge active back into main for re-validation
  const existingLinks = new Set(main.map((e) => e.link));
  const toAdd = active.filter((e) => !existingLinks.has(e.link))
    .map((e) => ({ ...e, status: 'unvalidated' as const, validatedAt: undefined }));

  saveBucket(ctx.telegramId, 'main', [...main, ...toAdd]);

  await ctx.answerCbQuery(`Merged ${toAdd.length} links`).catch(() => {});
  await handleBucketStatus(ctx);
}

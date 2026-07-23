// ============================================================
// WA-Bridge — Bucket Management Telegram Handlers
// Tri-bucket validator UI: view, filter, export, purge
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
} from '../../services/tri-bucket.js';
import { enqueueJob } from '../../services/queue.js';
import {
  bucketMenuKeyboard,
  bucketViewKeyboard,
} from '../ui/keyboards.js';
import { header, H, bucketCard, kv, card, noticeCard, escape } from '../../utils/formatter.js';
import { logger } from '../../utils/logger.js';
import { getSocket, getUserSockets } from '../../whatsapp/socket-manager.js';

const LINK_REGEX = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/g;

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
  const links = rawText.match(LINK_REGEX) ?? [];

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
    await ctx.answerCbQuery('No active sessions — connect WhatsApp first').catch(() => {});
    return;
  }

  const sessionId = sessionIds[0]!;
  const socket = getSocket(sessionId);
  if (!socket) {
    await ctx.answerCbQuery('Socket not ready').catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Filter started').catch(() => {});

  const main = loadBucket(ctx.telegramId, 'main');
  const progressMsg = await ctx.reply(
    card('Auto-Filter Running', '🔄', [['Pending', String(main.filter((e) => e.status === 'unvalidated').length)]], 'Validation is running in the background.'),
    { parse_mode: 'HTML' }
  );

  startAutoFilter(
    ctx.telegramId,
    sessionId,
    socket,
    async (msg) => {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progressMsg.message_id,
          undefined,
          escape(msg),
          { parse_mode: 'HTML' }
        );
      } catch {
        // Edit timeout — ignore
      }
    }
  ).then(async () => {
    const active = loadBucket(ctx.telegramId, 'active');
    const dead = loadBucket(ctx.telegramId, 'dead');
    await ctx.reply(
      card('Filter Complete', '✅', [
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

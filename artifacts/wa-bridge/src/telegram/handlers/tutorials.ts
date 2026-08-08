// ============================================================
// WA-Bridge — Telegram Tutorial Manager (Admin)
//
// Flow:
//   1. Open Tutorial Manager        → admin:tutorials
//   2. Select "Add Tutorial"        → admin:tutorials:add
//   3. Type the command name        → validated against the CENTRAL
//                                      command registry (MENU_CATALOG).
//                                      Unknown commands → "Command not found."
//   4. Choose Image / Video         → admin:tutorials:type:<image|video>
//   5. Upload the media             → stored against that exact command
//   6. Delete                       → admin:tutorials:del:<cmd> (+ confirm)
// ============================================================

import type { Context } from 'telegraf';
import fs from 'node:fs';
import { header, H, kv, noticeCard, escape } from '../../utils/formatter.js';
import { btn, backKeyboard, confirmKeyboard } from '../ui/keyboards.js';
import {
  listTutorials,
  getTutorial,
  saveTutorialMedia,
  readTutorialMediaAssets,
  removeTutorial,
  isValidTutorialCommand,
  validTutorialCommands,
  type TutorialMediaType,
} from '../../services/tutorials.js';
import { logger } from '../../utils/logger.js';

type TutorialContext = Context & { session: any; telegramId: string; isOwner: boolean };

type TelegramRenderContext = Context & {
  callbackQuery?: unknown;
  answerCbQuery: (text?: string, extra?: { show_alert?: boolean }) => Promise<unknown>;
  editMessageText: (text: string, extra?: Record<string, unknown>) => Promise<unknown>;
};

async function acknowledgeCallback(ctx: Context, text?: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery(text).catch((error) => {
    logger.warn('[Tutorials] callback acknowledgement failed', { err: String(error) });
  });
}

async function editOrReply(
  ctx: TelegramRenderContext,
  text: string,
  extra: Record<string, unknown>,
): Promise<void> {
  if (!ctx.callbackQuery) {
    await ctx.reply(text, extra as never);
    return;
  }
  try {
    await ctx.editMessageText(text, extra);
  } catch (error) {
    logger.warn('[Tutorials] callback message edit failed, replying fresh', { err: String(error) });
    await ctx.reply(text, extra as never).catch((replyError) => {
      logger.error('[Tutorials] callback fallback reply failed', { err: String(replyError) });
    });
  }
}

/** Render the tutorial list + actions. */
export async function handleTutorialsMenu(ctx: Context, acknowledge = true): Promise<void> {
  if (acknowledge) await acknowledgeCallback(ctx);
  let tutorials;
  try {
    tutorials = listTutorials();
  } catch (error) {
    logger.error('[Tutorials] list failed', { err: String(error) });
    await ctx.reply(noticeCard('Tutorial Manager Failed', 'Tutorial data could not be loaded. Try again shortly.', 'error'), { parse_mode: 'HTML' }).catch((replyError) => {
      logger.error('[Tutorials] failure response failed', { err: String(replyError) });
    });
    return;
  }
  const lines = [
    header('Tutorial Manager', '🎬'),
    '',
    kv('Commands with tutorials:', String(tutorials.length)),
    '',
  ];

  if (tutorials.length === 0) {
    lines.push(H.italic('No tutorials attached yet.'));
  } else {
    for (const t of tutorials) {
      const emoji = t.type === 'video' ? '🎞' : '🖼';
      lines.push(`${emoji} ${H.code(t.command)} — ${t.type} (${escape(t.mimeType)})`);
    }
  }

  lines.push('', H.blockquote(`Tutorial media is attached to ${H.code('.help <command>')} on WhatsApp for every session.`));

  const rows = tutorials.map((t) => [
    btn(`${t.type === 'video' ? '🎞' : '🖼'} ${t.command}`, `admin:tutorials:del:${t.command}`, 'danger'),
  ]);
  rows.push([btn('➕ Add Tutorial', 'admin:tutorials:add', 'primary')]);
  if (tutorials.some((tutorial) => tutorial.command === 'gameapi')) rows.push([btn('👁 Preview Game API', 'admin:tutorials:preview:gameapi', 'primary')]);
  rows.push([btn('🔙 Back', 'admin:panel', 'primary')]);

  const markup = { inline_keyboard: rows };
  const text = lines.join('\n');
  await editOrReply(ctx as TelegramRenderContext, text, { parse_mode: 'HTML', reply_markup: markup });
}

/** Step 2 — prompt for a command name (registry list shown). */
export async function handleTutorialAdd(ctx: TutorialContext): Promise<void> {
  await acknowledgeCallback(ctx, 'Add Tutorial');
  ctx.session.awaitingTutorialCommand = true;
  delete ctx.session.tutorialPending;

  const commands = validTutorialCommands();
  const list = commands
    .map((c) => `• ${H.code(c)}`)
    .join('\n');

  await editOrReply(ctx as TelegramRenderContext, [
    header('Add Tutorial', '➕'),
    '',
    'Send the exact command name you want to attach a tutorial to.',
    '',
    H.blockquote('Registered commands (central registry):'),
    list,
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: backKeyboard('admin:tutorials'),
  });
}

/** Step 3 — validate the typed command name. */
export async function processTutorialCommand(ctx: TutorialContext): Promise<void> {
  if (!ctx.session.awaitingTutorialCommand) return;
  ctx.session.awaitingTutorialCommand = false;

  const raw = String((ctx.message as any)?.text ?? '').trim();
  const command = raw.replace(/^[./!]+/, '').toLowerCase();

  if (!isValidTutorialCommand(command)) {
    const commands = validTutorialCommands();
    await ctx.reply(
      [
        noticeCard('Command Not Found', `No command named ${H.code(raw || '—')} is registered.`, 'error'),
        '',
        'Valid registered commands:',
        commands.map((c) => `• ${H.code(c)}`).join('\n'),
        '',
        H.blockquote('Send the exact command name, or tap Back to cancel.'),
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: backKeyboard('admin:tutorials'),
      }
    );
    ctx.session.awaitingTutorialCommand = true; // let them retry
    return;
  }

  ctx.session.tutorialPending = { command };
  const existing = getTutorial(command);
  await ctx.reply(
    [
      header('Tutorial Media Type', '🎬'),
      '',
      kv('Command:', H.code(command)),
      existing ? kv('Replaces:', `${existing.type} (added ${new Date(existing.addedAt).toLocaleString()})`) : '',
      '',
      'Choose the tutorial media type:',
    ].filter(Boolean).join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [btn('🖼 Image', 'admin:tutorials:type:image', 'primary'), btn('🎞 Video', 'admin:tutorials:type:video', 'primary')],
          [btn('🔙 Back', 'admin:tutorials', 'primary')],
        ],
      },
    }
  );
}

/** Step 4 — remember the media type and prompt for upload. */
export async function handleTutorialType(ctx: TutorialContext, type: TutorialMediaType): Promise<void> {
  const pending = ctx.session.tutorialPending as { command: string; type?: TutorialMediaType } | undefined;
  if (!pending?.command) {
    await ctx.answerCbQuery('Start over — press Add Tutorial').catch(() => {});
    await handleTutorialsMenu(ctx, false);
    return;
  }
  pending.type = type;
  ctx.session.tutorialPending = pending;

  await acknowledgeCallback(ctx, type === 'image' ? 'Send an image now' : 'Send a video now');
  await editOrReply(ctx as TelegramRenderContext, [
    header(type === 'image' ? 'Send Image' : 'Send Video', type === 'image' ? '🖼' : '🎞'),
    '',
    kv('Command:', H.code(pending.command)),
    '',
    H.blockquote(`Upload the ${type} now. It will be stored against .help ${pending.command}.`),
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: backKeyboard('admin:tutorials'),
  });
}

/** Step 5 — save the uploaded media buffer against the pending command. */
export async function saveTutorialUpload(
  ctx: TutorialContext,
  buffer: Buffer,
  mimeType: string
): Promise<void> {
  const pending = ctx.session.tutorialPending as { command: string; type?: TutorialMediaType } | undefined;
  if (!pending?.command || !pending.type) return;
  delete ctx.session.tutorialPending;

  if (!buffer || buffer.length === 0) {
    await ctx.reply(noticeCard('Upload Failed', 'No media received — try again.', 'error'), {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    });
    return;
  }

  const mediaType = pending.type;
  if (!mediaType) {
    await ctx.reply(noticeCard('Upload Failed', 'Choose Image or Video before uploading media.', 'error'), {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    });
    return;
  }
  if (mimeType !== `${mediaType}/` && !mimeType.startsWith(`${mediaType}/`)) {
    await ctx.reply(noticeCard('Upload Failed', `Expected a ${mediaType}, received ${mimeType || 'unknown media type'}.`, 'error'), {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    });
    return;
  }
  if (buffer.length > 25 * 1024 * 1024) {
    await ctx.reply(noticeCard('Upload Failed', 'Media exceeds the 25 MB helper-media limit.', 'error'), {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    });
    return;
  }
  const record = saveTutorialMedia(pending.command, mediaType, buffer, mimeType);
  if (!record) {
    await ctx.reply(noticeCard('Save Failed', 'The tutorial command is no longer valid, or the media could not be persisted. Check the server log for the safe failure reason.', 'error'), {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    });
    return;
  }

  logger.info('[Tutorials] media attached', { command: record.command, type: record.type });
  await ctx.reply(
    cardSuccess(ctx, record.command, record.type!),
    {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    }
  );
}

function cardSuccess(ctx: Context, command: string, type: TutorialMediaType): string {
  const t = getTutorial(command);
  const size = t && typeof t.filePath === 'string' && t.filePath ? '—' : '';
  void size;
  return [
    header('Tutorial Saved', '✅'),
    '',
    kv('Command:', H.code(command)),
    kv('Type:', type),
    kv('When:', new Date().toLocaleString()),
    '',
    H.blockquote(`WhatsApp .help ${command} will now attach this ${type}.`),
  ].join('\n');
}

/** Send a stored tutorial asset back to the admin as a real Telegram preview. */
export async function handleTutorialPreview(ctx: Context, command: string): Promise<void> {
  const tutorial = getTutorial(command);
  const media = readTutorialMediaAssets(command);
  if (media.length === 0) {
    await ctx.answerCbQuery('No helper media is stored for this tutorial', { show_alert: true }).catch(() => {});
    return;
  }
  await acknowledgeCallback(ctx, 'Sending preview…');
  const caption = tutorial?.title ?? `Tutorial preview: ${command}`;
  try {
    for (const [index, asset] of media.entries()) {
      if (asset.type === 'image') {
        await ctx.replyWithPhoto({ source: asset.buffer }, { caption: index === 0 ? caption : undefined });
      } else {
        await ctx.replyWithVideo({ source: asset.buffer }, { caption: index === 0 ? caption : undefined });
      }
    }
  } catch (error) {
    await ctx.reply(noticeCard('Tutorial Preview Failed', String(error), 'error'), {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    });
  }
}

/** Delete — show confirmation. */
export async function handleTutorialDelete(ctx: Context, command: string): Promise<void> {
  const t = getTutorial(command);
  if (!t) {
    await ctx.answerCbQuery('Tutorial not found').catch(() => {});
    await handleTutorialsMenu(ctx);
    return;
  }
  await acknowledgeCallback(ctx, 'Review removal');
  await editOrReply(ctx as TelegramRenderContext, [
    header('Confirm: Remove Tutorial', '⚠️'),
    '',
    `Remove the ${t.type} tutorial attached to ${H.code(t.command)}?`,
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: confirmKeyboard(`admin:tutorials:delconfirm:${t.command}`, 'admin:tutorials'),
  });
}

/** Delete — execute. */
export async function handleTutorialDeleteConfirm(ctx: Context, command: string): Promise<void> {
  removeTutorial(command);
  await acknowledgeCallback(ctx, 'Tutorial removed');
  await handleTutorialsMenu(ctx, false);
}

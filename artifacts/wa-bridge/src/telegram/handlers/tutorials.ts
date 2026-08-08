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
import { header, H, kv, noticeCard, escape } from '../../utils/formatter.js';
import { btn, backKeyboard, confirmKeyboard } from '../ui/keyboards.js';
import {
  listTutorials,
  getTutorial,
  saveTutorialMedia,
  removeTutorial,
  isValidTutorialCommand,
  validTutorialCommands,
  type TutorialMediaType,
} from '../../services/tutorials.js';
import { logger } from '../../utils/logger.js';

type TutorialContext = Context & { session: any; telegramId: string; isOwner: boolean };

/** Render the tutorial list + actions. */
export async function handleTutorialsMenu(ctx: Context): Promise<void> {
  const tutorials = listTutorials();
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

  lines.push('', H.blockquote('Tutorial media is attached to .help <command> on WhatsApp for every session.'));

  const rows = tutorials.map((t) => [
    btn(`${t.type === 'video' ? '🎞' : '🖼'} ${t.command}`, `admin:tutorials:del:${t.command}`, 'danger'),
  ]);
  rows.push([btn('➕ Add Tutorial', 'admin:tutorials:add', 'primary')]);
  rows.push([btn('🔙 Back', 'admin:panel', 'primary')]);

  const markup = { inline_keyboard: rows };
  const text = lines.join('\n');
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: markup });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup });
    }
  } catch (err) {
    // A stale/older message may no longer be editable — fall back to a
    // fresh reply so the Tutorial Manager always opens.
    logger.warn('[Tutorials] menu edit failed, replying fresh', { err: String(err) });
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
  }
}

/** Step 2 — prompt for a command name (registry list shown). */
export async function handleTutorialAdd(ctx: TutorialContext): Promise<void> {
  ctx.session.awaitingTutorialCommand = true;
  delete ctx.session.tutorialPending;

  const commands = validTutorialCommands();
  const list = commands
    .map((c) => `• ${H.code(c)}`)
    .join('\n');

  await ctx.editMessageText(
    [
      header('Add Tutorial', '➕'),
      '',
      'Send the exact command name you want to attach a tutorial to.',
      '',
      H.blockquote('Registered commands (central registry):'),
      list,
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    }
  ).catch(() => {});
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
    await handleTutorialsMenu(ctx);
    return;
  }
  pending.type = type;
  ctx.session.tutorialPending = pending;

  await ctx.answerCbQuery(type === 'image' ? 'Send an image now' : 'Send a video now').catch(() => {});
  await ctx.editMessageText(
    [
      header(type === 'image' ? 'Send Image' : 'Send Video', type === 'image' ? '🖼' : '🎞'),
      '',
      kv('Command:', H.code(pending.command)),
      '',
      H.blockquote(`Upload the ${type} now. It will be stored against .help ${pending.command}.`),
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    }
  ).catch(() => {});
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

  const record = saveTutorialMedia(pending.command, pending.type, buffer, mimeType);
  if (!record) {
    await ctx.reply(noticeCard('Save Failed', 'The command is no longer valid in the registry.', 'error'), {
      parse_mode: 'HTML',
      reply_markup: backKeyboard('admin:tutorials'),
    });
    return;
  }

  logger.info('[Tutorials] media attached', { command: record.command, type: record.type });
  await ctx.reply(
    cardSuccess(ctx, record.command, record.type),
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

/** Delete — show confirmation. */
export async function handleTutorialDelete(ctx: Context, command: string): Promise<void> {
  const t = getTutorial(command);
  if (!t) {
    await ctx.answerCbQuery('Tutorial not found').catch(() => {});
    await handleTutorialsMenu(ctx);
    return;
  }
  await ctx.editMessageText(
    [
      header('Confirm: Remove Tutorial', '⚠️'),
      '',
      `Remove the ${t.type} tutorial attached to ${H.code(t.command)}?`,
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard(`admin:tutorials:delconfirm:${t.command}`, 'admin:tutorials'),
    }
  ).catch(() => {});
}

/** Delete — execute. */
export async function handleTutorialDeleteConfirm(ctx: Context, command: string): Promise<void> {
  const removed = removeTutorial(command);
  await ctx.answerCbQuery(removed ? 'Tutorial removed' : 'Tutorial not found').catch(() => {});
  await handleTutorialsMenu(ctx);
}

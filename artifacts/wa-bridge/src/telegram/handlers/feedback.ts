// ============================================================
// WA-Bridge — Telegram Feedback Handlers
// ============================================================

import type { Context } from 'telegraf';
import { addIdea, loadIdeas, updateIdeaStatus, deleteIdea, IdeaEntry } from '../../services/ideas.js';
import { adminIdeasKeyboard, adminIdeaViewKeyboard, backKeyboard } from '../ui/keyboards.js';
import { header, kv, H, noticeCard } from '../../utils/formatter.js';
import { logger } from '../../utils/logger.js';

// State to track if user is in "idea submission" mode
const submissionMode = new Set<string>();

export async function handleIdeaSubmit(ctx: Context & { telegramId: string }): Promise<void> {
  submissionMode.add(ctx.telegramId);
  await ctx.answerCbQuery('Send your idea…').catch(() => {});
  await ctx.reply(
    `${header('Send Your Idea', '💡')}\n\nPlease send your suggestion, feedback, or bug report.\n\nYou can include text, photos, videos, or any other media.`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true } }
  );
}

export async function processTelegramIdea(ctx: Context & { telegramId: string }): Promise<void> {
  if (!submissionMode.has(ctx.telegramId)) return;
  submissionMode.delete(ctx.telegramId);

  const msg = ctx.message as any;
  const attachments: any[] = [];

  if (msg.photo) attachments.push({ type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id });
  if (msg.video) attachments.push({ type: 'video', fileId: msg.video.file_id });
  if (msg.audio) attachments.push({ type: 'audio', fileId: msg.audio.file_id });
  if (msg.voice) attachments.push({ type: 'voice', fileId: msg.voice.file_id });
  if (msg.document) attachments.push({ type: 'document', fileId: msg.document.file_id });
  if (msg.sticker) attachments.push({ type: 'sticker', fileId: msg.sticker.file_id });
  if (msg.animation) attachments.push({ type: 'animation', fileId: msg.animation.file_id });

  addIdea({
    platform: 'telegram',
    telegramId: ctx.telegramId,
    username: msg.from?.username || msg.from?.first_name,
    message: msg.text || msg.caption,
    attachments,
  });

  await ctx.reply(
    noticeCard('Idea Received', 'Thank you! Your suggestion has been sent to the administrator.', 'success'),
    { parse_mode: 'HTML' }
  );
}

// ── Admin Idea Inbox ──────────────────────────────────────

export async function handleAdminIdeas(ctx: Context, page = 0): Promise<void> {
  const ideas = loadIdeas().sort((a, b) => b.timestamp - a.timestamp);
  
  await ctx.editMessageText(
    `${header('Idea Inbox', '💡')}\n\n${H.italic(`${ideas.length} suggestions received`)}`,
    { parse_mode: 'HTML', reply_markup: adminIdeasKeyboard(ideas, page) }
  ).catch(() => {});
}

export async function handleAdminIdeaView(ctx: Context, ideaId: string): Promise<void> {
  const ideas = loadIdeas();
  const idea = ideas.find((i) => i.id === ideaId);
  if (!idea) {
    await ctx.answerCbQuery('Idea not found', { show_alert: true }).catch(() => {});
    return;
  }

  // Mark as read if it was open
  if (idea.status === 'open') {
    updateIdeaStatus(ideaId, 'read');
  }

  const text = [
    header(`Idea: ${idea.id}`, '💡'),
    '',
    kv('Platform:', idea.platform === 'telegram' ? '🔵 Telegram' : '🟢 WhatsApp'),
    kv('User:', idea.username ?? 'Unknown'),
    kv('ID/Phone:', idea.telegramId ?? idea.whatsappNumber ?? 'N/A'),
    kv('Status:', idea.status.toUpperCase()),
    kv('Time:', new Date(idea.timestamp).toLocaleString()),
    '',
    H.bold('Message:'),
    idea.message ? H.blockquote(idea.message) : H.italic('No text message'),
    '',
    kv('Attachments:', String(idea.attachments.length)),
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: adminIdeaViewKeyboard(ideaId, idea.status),
  }).catch(() => {});

  // Send attachments if any
  for (const att of idea.attachments) {
    if (att.fileId) {
      try {
        if (att.type === 'photo') await ctx.telegram.sendPhoto(ctx.chat!.id, att.fileId);
        else if (att.type === 'video') await ctx.telegram.sendVideo(ctx.chat!.id, att.fileId);
        else if (att.type === 'audio') await ctx.telegram.sendAudio(ctx.chat!.id, att.fileId);
        else if (att.type === 'voice') await ctx.telegram.sendVoice(ctx.chat!.id, att.fileId);
        else if (att.type === 'document') await ctx.telegram.sendDocument(ctx.chat!.id, att.fileId);
        else if (att.type === 'sticker') await ctx.telegram.sendSticker(ctx.chat!.id, att.fileId);
        else if (att.type === 'animation') await ctx.telegram.sendAnimation(ctx.chat!.id, att.fileId);
      } catch (err) {
        logger.warn('[Admin] Failed to send idea attachment', { err: String(err) });
      }
    }
  }
}

export async function handleAdminIdeaDelete(ctx: Context, ideaId: string): Promise<void> {
  deleteIdea(ideaId);
  await ctx.answerCbQuery('Idea deleted').catch(() => {});
  await handleAdminIdeas(ctx);
}

export async function handleAdminIdeaComplete(ctx: Context, ideaId: string): Promise<void> {
  updateIdeaStatus(ideaId, 'completed');
  await ctx.answerCbQuery('Marked as completed').catch(() => {});
  await handleAdminIdeaView(ctx, ideaId);
}

export async function handleAdminIdeaReply(ctx: any, ideaId: string): Promise<void> {
  ctx.session.awaitingIdeaReplyId = ideaId;
  await ctx.editMessageText(
    `${header('Reply to Idea', '📩')}\n\nIdea ID: ${H.code(ideaId)}\n\nPlease send the message you want to send to the user.`,
    { parse_mode: 'HTML', reply_markup: backKeyboard(`admin:idea:${ideaId}`) }
  ).catch(() => {});
}

export async function processAdminIdeaReply(ctx: Context & { session: any }): Promise<void> {
  if (!ctx.session.awaitingIdeaReplyId) return;
  const ideaId = ctx.session.awaitingIdeaReplyId;
  delete ctx.session.awaitingIdeaReplyId;

  const text = (ctx.message as any).text?.trim();
  if (!text) {
    await ctx.reply(noticeCard('Empty Message', 'Reply cannot be empty.', 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`admin:idea:${ideaId}`) });
    return;
  }

  const ideas = loadIdeas();
  const idea = ideas.find(i => i.id === ideaId);
  if (!idea) {
    await ctx.reply(noticeCard('Idea Not Found', 'Could not find the original idea.', 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard('admin:ideas:0') });
    return;
  }

  try {
    // Send reply to the user
    if (!idea.telegramId) throw new Error('Idea has no Telegram ID');
    await (ctx as any).telegram.sendMessage(parseInt(idea.telegramId, 10), [
      header('Response to your Suggestion', '📩'),
      '',
      H.bold('Your Idea:'),
      H.blockquote(idea.message || 'No text'),
      '',
      H.bold('Admin Response:'),
      H.blockquote(text),
    ].join('\n'), { parse_mode: 'HTML' });

    await ctx.reply(noticeCard('Reply Sent', `Your response has been delivered to the user.`, 'success'), { parse_mode: 'HTML', reply_markup: backKeyboard(`admin:idea:${ideaId}`) });
  } catch (err) {
    await ctx.reply(noticeCard('Delivery Failed', `Could not send message to user: ${String(err)}`, 'error'), { parse_mode: 'HTML', reply_markup: backKeyboard(`admin:idea:${ideaId}`) });
  }
}

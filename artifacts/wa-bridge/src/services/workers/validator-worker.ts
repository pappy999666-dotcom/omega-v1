// ============================================================
// WA-Bridge — BullMQ Validator Worker
// Headless link validation via groupGetInviteInfo
// Live Telegram dashboard editing + session failover
// ============================================================

import { Worker, type Job } from 'bullmq';
import type { JobPayload, JobResult } from '../../types/index.js';
import { QUEUE_NAMES, getRedis, registerWorker } from '../queue.js';
import { getSocket, getUserSockets } from '../../whatsapp/socket-manager.js';
import { validateAllLinks } from '../tri-bucket.js';
import { logger } from '../../utils/logger.js';
import { createProgressCoalescer } from '../../utils/progress.js';

let tgBot: {
  telegram: {
    sendMessage: (chatId: number, text: string, opts?: object) => Promise<unknown>;
    editMessageText: (chatId: number, msgId: number, _: null | undefined, text: string, opts?: object) => Promise<unknown>;
  };
} | null = null;

export function setValidatorBotRef(bot: typeof tgBot): void {
  tgBot = bot;
}

async function processValidation(job: Job<JobPayload>): Promise<JobResult> {
  const { telegramId, sessionId, chatId, messageId } = job.data;
  const socket = getSocket(sessionId);

  if (!socket) {
    return {
      success: 0,
      failed: 0,
      skipped: 0,
      rateLimited: 0,
      details: [`No socket for ${sessionId}`],
      duration: 0,
    };
  }

  const start = Date.now();

  // Live dashboard: prefer editing an existing message, fall back to sending
  let progressMsgId = messageId;

  const deliverProgress = async (html: string): Promise<void> => {
    await job.updateProgress(html);
    if (!tgBot || !chatId) return;

    try {
      if (progressMsgId) {
        await tgBot.telegram.editMessageText(
          chatId,
          progressMsgId,
          undefined,
          html,
          { parse_mode: 'HTML' }
        );
      } else {
        const sent = await tgBot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' }) as { message_id?: number };
        if (sent?.message_id) progressMsgId = sent.message_id;
      }
    } catch {
      // Message may have been deleted or edit window expired — send fresh.
      try {
        const sent = await tgBot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' }) as { message_id?: number };
        if (sent?.message_id) progressMsgId = sent.message_id;
      } catch { /* ignore */ }
    }
  };
  const progress = createProgressCoalescer(deliverProgress);
  const onProgress = progress.update;

  // Build session failover helper: returns next healthy session for this user
  const usedSessions = new Set<string>([sessionId]);
  const getAlternativeSocket = (_currentSessionId: string): { socket: import('../../whatsapp/baileys-types.js').BridgeWASocket; sessionId: string } | null => {
    const allSessions = getUserSockets(telegramId);
    for (const sid of allSessions) {
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

  const result = await validateAllLinks(telegramId, sessionId, socket, onProgress, getAlternativeSocket);

  // Flush the latest live state before the final summary message.
  await progress.flush();

  // Final summary message. Queue it through the same coalescer, then flush so
  // the worker cannot finish with the final state stuck in memory.
  const summaryHtml = [
    `<blockquote>`,
    `<b>◈ OMEGA VALIDATOR — COMPLETE</b>`,
    ``,
    `Activated   ${result.activated.toLocaleString('en-US')}`,
    `Dead        ${result.killed.toLocaleString('en-US')}`,
    `Errors      ${result.errors}`,
    `Retries     ${result.retries}`,
    `Remaining   ${result.remaining.toLocaleString('en-US')}`,
    result.sessionSwitched ? `Session     SWITCHED` : '',
    result.rateLimitPaused ? `\n⚠ Rate limit — remaining links kept in Main` : '',
    `</blockquote>`,
  ].filter(Boolean).join('\n');

  await onProgress(summaryHtml);
  await progress.flush();

  return {
    success: result.activated,
    failed: result.errors,
    skipped: 0,
    rateLimited: result.rateLimitPaused ? 1 : 0,
    details: [
      `Activated: ${result.activated}`,
      `Dead: ${result.killed}`,
      `Errors: ${result.errors}`,
      `Retries: ${result.retries}`,
      `Remaining in Main: ${result.remaining}`,
      result.sessionSwitched ? 'Session failover occurred' : '',
    ].filter(Boolean),
    duration: Date.now() - start,
  };
}

export function startValidatorWorker(): Worker {
  const worker = new Worker<JobPayload, JobResult>(
    QUEUE_NAMES.VALIDATOR,
    processValidation,
    {
      connection: getRedis(),
      concurrency: 2,
      limiter: { max: 10, duration: 60_000 },
    }
  );

  registerWorker(worker);
  logger.info('[ValidatorWorker] Started');
  return worker;
}

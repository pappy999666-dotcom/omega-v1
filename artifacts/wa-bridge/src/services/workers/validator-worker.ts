// ============================================================
// WA-Bridge — BullMQ Validator Worker
// Headless link validation via groupGetInviteInfo
// ============================================================

import { Worker, type Job } from 'bullmq';
import type { JobPayload, JobResult } from '../../types/index.js';
import { QUEUE_NAMES, getRedis, registerWorker } from '../queue.js';
import { getSocket } from '../../whatsapp/socket-manager.js';
import { validateAllLinks } from '../tri-bucket.js';
import { logger } from '../../utils/logger.js';

let tgBot: { telegram: { sendMessage: (chatId: number, text: string, opts?: object) => Promise<unknown> } } | null = null;

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

  const onProgress = async (msg: string): Promise<void> => {
    await job.updateProgress(msg);
    if (tgBot && chatId) {
      try {
        await tgBot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      } catch { /* ignore */ }
    }
  };

  const result = await validateAllLinks(telegramId, sessionId, socket, onProgress);

  return {
    success: result.activated,
    failed: result.errors,
    skipped: 0,
    rateLimited: result.rateLimitPaused ? 1 : 0,
    details: [`Activated: ${result.activated}`, `Dead: ${result.killed}`, `Errors: ${result.errors}`, `Retries: ${result.retries}`, `Remaining in Main: ${result.remaining}`],
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

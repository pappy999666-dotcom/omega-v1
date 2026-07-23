// ============================================================
// WA-Bridge — BullMQ Outreach Worker
// Handles allstatus, allchat, sstatus, tochatx jobs
// ============================================================

import { Worker, type Job } from 'bullmq';
import type { JobPayload, JobResult } from '../../types/index.js';
import { QUEUE_NAMES, getRedis, registerWorker } from '../queue.js';
import { getSocket } from '../../whatsapp/socket-manager.js';
import { cmdAllStatus, cmdAllChat } from '../../whatsapp/commands/mass-outreach.js';
import { cmdToChatX } from '../../whatsapp/commands/status.js';
import { logger } from '../../utils/logger.js';

let tgBot: { telegram: { sendMessage: (chatId: number, text: string, opts?: object) => Promise<unknown>; editMessageText: (chatId: number, msgId: number, _: null, text: string, opts?: object) => Promise<unknown> } } | null = null;

export function setOutreachBotRef(bot: typeof tgBot): void {
  tgBot = bot;
}

async function updateProgress(
  chatId: number | undefined,
  msgId: number | undefined,
  text: string
): Promise<void> {
  if (!tgBot || !chatId) return;
  try {
    if (msgId) {
      await tgBot.telegram.editMessageText(chatId, msgId, null, text, { parse_mode: 'HTML' });
    } else {
      await tgBot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }
  } catch {
    // Edit may fail if message is too old — ignore
  }
}

async function processOutreach(job: Job<JobPayload>): Promise<JobResult> {
  const { telegramId, sessionId, type, data, chatId, messageId } = job.data;
  const socket = getSocket(sessionId);

  if (!socket) {
    logger.warn(`[OutreachWorker] No socket for ${sessionId}`);
    return { success: 0, failed: 0, skipped: 0, rateLimited: 0, details: ['No socket'], duration: 0 };
  }

  const onProgress = async (msg: string): Promise<void> => {
    await job.updateProgress(msg);
    await updateProgress(chatId, messageId, msg);
  };

  const text = data.text as string ?? '';

  switch (type) {
    case 'allstatus':
      return cmdAllStatus(socket, sessionId, telegramId, text, {
        mediaBuffer: data.mediaBuffer ? Buffer.from(data.mediaBuffer as string, 'base64') : undefined,
        mediaType: data.mediaType as string,
        onProgress,
      });

    case 'allchat':
      return cmdAllChat(socket, sessionId, telegramId, text, {
        mediaBuffer: data.mediaBuffer ? Buffer.from(data.mediaBuffer as string, 'base64') : undefined,
        mediaType: data.mediaType as string,
        onProgress,
      });

    case 'tochatx': {
      const target = data.target as string;
      const count = data.count as number ?? 1;
      const result = await cmdToChatX(socket, sessionId, target, count, text);
      await onProgress(`✅ Sent ${result.sent}/${count} to ${target}`);
      return { success: result.sent, failed: result.failed, skipped: 0, rateLimited: 0, details: [], duration: 0 };
    }

    default:
      return { success: 0, failed: 0, skipped: 0, rateLimited: 0, details: [`Unknown type: ${type}`], duration: 0 };
  }
}

export function startOutreachWorker(): Worker {
  const worker = new Worker<JobPayload, JobResult>(
    QUEUE_NAMES.OUTREACH,
    processOutreach,
    {
      connection: getRedis(),
      concurrency: 1, // Serial outreach to prevent ban cascades
      limiter: { max: 5, duration: 60_000 }, // 5 jobs/min
    }
  );

  registerWorker(worker);
  logger.info('[OutreachWorker] Started');
  return worker;
}

// ============================================================
// WA-Bridge — BullMQ Outreach Worker
// Handles allstatus, allchat, sstatus, tochatx jobs
// ============================================================

import { Worker, type Job } from 'bullmq';
import type { JobPayload, JobResult } from '../../types/index.js';
import { QUEUE_NAMES, getRedis, registerWorker } from '../queue.js';
import { getSocket } from '../../whatsapp/socket-manager.js';
import { cmdAllStatus } from '../../whatsapp/commands/all-status.js';
import { cmdAllChat } from '../../whatsapp/commands/mass-outreach.js';
import { cmdToChatX } from '../../whatsapp/commands/status.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/delay.js';

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

// Wait up to 90s for the session socket to become available after a restart
async function waitForSocket(sessionId: string, maxWaitMs = 90_000): Promise<ReturnType<typeof getSocket>> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const socket = getSocket(sessionId);
    if (socket) return socket;
    await sleep(3000);
  }
  return null;
}

async function processOutreach(job: Job<JobPayload>): Promise<JobResult> {
  const { telegramId, sessionId, type, data, chatId, messageId } = job.data;

  // Wait for socket — handles the case where the job resumes before WA reconnects
  const socket = await waitForSocket(sessionId);

  if (!socket) {
    logger.warn(`[OutreachWorker] No socket for ${sessionId} after wait — requeueing`);
    throw new Error(`Session ${sessionId} not available — will retry`);
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
      concurrency: 1,
      limiter: { max: 5, duration: 60_000 },
      stalledInterval: 30_000,   // check for stalled jobs every 30s
      maxStalledCount: 3,        // retry stalled jobs up to 3 times before failing
    }
  );

  registerWorker(worker);
  logger.info('[OutreachWorker] Started');
  return worker;
}

// ============================================================
// WA-Bridge — BullMQ Lifecycle Worker
// Handles joinall and leaveall bulk operations
// ============================================================

import { Worker, type Job } from 'bullmq';
import type { JobPayload, JobResult } from '../../types/index.js';
import { QUEUE_NAMES, getRedis, registerWorker } from '../queue.js';
import { getSocket } from '../../whatsapp/socket-manager.js';
import { cmdJoinAll, cmdLeaveAll } from '../../whatsapp/commands/lifecycle.js';
import { loadBucket } from '../workspace.js';
import { logger } from '../../utils/logger.js';

let tgBot: { telegram: { sendMessage: (chatId: number, text: string, opts?: object) => Promise<unknown> } } | null = null;

export function setLifecycleBotRef(bot: typeof tgBot): void {
  tgBot = bot;
}

async function processLifecycle(job: Job<JobPayload>): Promise<JobResult> {
  const { telegramId, sessionId, type, chatId } = job.data;
  const socket = getSocket(sessionId);

  if (!socket) {
    return { success: 0, failed: 0, skipped: 0, rateLimited: 0, details: ['No socket'], duration: 0 };
  }

  const onProgress = async (msg: string): Promise<void> => {
    await job.updateProgress(msg);
    if (tgBot && chatId) {
      try {
        await tgBot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      } catch { /* ignore */ }
    }
  };

  switch (type) {
    case 'joinall': {
      const links = loadBucket(telegramId, 'active').map((e) => e.link);
      return cmdJoinAll(socket, sessionId, telegramId, links, { onProgress });
    }

    case 'leaveall': {
      return cmdLeaveAll(socket, sessionId, telegramId, { onProgress });
    }

    default:
      return { success: 0, failed: 0, skipped: 0, rateLimited: 0, details: [`Unknown: ${type}`], duration: 0 };
  }
}

export function startLifecycleWorker(): Worker {
  const worker = new Worker<JobPayload, JobResult>(
    QUEUE_NAMES.LIFECYCLE,
    processLifecycle,
    {
      connection: getRedis(),
      concurrency: 1,
      limiter: { max: 3, duration: 60_000 },
    }
  );

  registerWorker(worker);
  logger.info('[LifecycleWorker] Started');
  return worker;
}

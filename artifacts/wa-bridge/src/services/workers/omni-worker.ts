// ============================================================
// WA-Bridge — BullMQ Omni-Bridge Worker
// Admin: blast a command across ALL active sessions on the platform
// ============================================================

import { Worker, type Job } from 'bullmq';
import type { JobPayload, JobResult } from '../../types/index.js';
import { QUEUE_NAMES, getRedis, registerWorker } from '../queue.js';
import { getAllSockets } from '../../whatsapp/socket-manager.js';
import { logger } from '../../utils/logger.js';
import { jitter } from '../../utils/delay.js';

async function processOmni(job: Job<JobPayload>): Promise<JobResult> {
  const { data } = job.data;
  const command = data.command as string;
  const text = data.text as string ?? '';

  const start = Date.now();
  const result: JobResult = {
    success: 0,
    failed: 0,
    skipped: 0,
    rateLimited: 0,
    details: [],
    duration: 0,
  };

  const sockets = getAllSockets();

  for (const [sessionId, handle] of sockets.entries()) {
    if (handle.frozen) {
      result.skipped++;
      continue;
    }

    try {
      switch (command) {
        case 'broadcast': {
          const groups = await handle.socket.groupFetchAllParticipating();
          for (const group of Object.values(groups).slice(0, 5)) {
            await handle.socket.sendMessage(group.id, { text });
            await jitter(1000, 2000);
          }
          result.success++;
          break;
        }

        case 'status': {
          await handle.socket.sendMessage('status@broadcast', { text });
          result.success++;
          break;
        }

        default:
          result.skipped++;
      }

      result.details.push(`✅ ${sessionId}`);
    } catch (err) {
      result.failed++;
      result.details.push(`❌ ${sessionId}: ${String(err).slice(0, 40)}`);
    }

    await jitter(500, 1000);
  }

  result.duration = Date.now() - start;
  logger.info('[OmniWorker] Omni command complete', result);
  return result;
}

export function startOmniWorker(): Worker {
  const worker = new Worker<JobPayload, JobResult>(
    QUEUE_NAMES.OMNI,
    processOmni,
    {
      connection: getRedis(),
      concurrency: 1,
      limiter: { max: 2, duration: 60_000 },
    }
  );

  registerWorker(worker);
  logger.info('[OmniWorker] Started');
  return worker;
}

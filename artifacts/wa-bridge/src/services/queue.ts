// ============================================================
// WA-Bridge — BullMQ Queue & Worker Setup
// All WhatsApp network tasks run here, never on the event loop
// ============================================================

import { Queue, Worker, QueueEvents, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';
import type { JobPayload, JobResult } from '../types/index.js';

// ── Redis Connection ──────────────────────────────────────

export function createRedis(): Redis {
  const options = {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  } as const;

  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    return new Redis(redisUrl, options);
  }

  return new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB ?? '0', 10),
    ...options,
  });
}

// Shared Redis instances
let _redis: Redis | null = null;
let _subRedis: Redis | null = null;
let lastRedisErrorAt = 0;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = createRedis();
    _redis.on('error', (err) => {
      const now = Date.now();
      if (now - lastRedisErrorAt >= 30_000) {
        lastRedisErrorAt = now;
        logger.error('[Redis] Connection error', { err: err.message });
      }
    });
    _redis.on('connect', () => {
      lastRedisErrorAt = 0;
      logger.info('[Redis] Connected');
    });
  }
  return _redis;
}

export function getSubRedis(): Redis {
  if (!_subRedis) {
    _subRedis = createRedis();
  }
  return _subRedis;
}

// ── Queue Names ───────────────────────────────────────────

export const QUEUE_NAMES = {
  OUTREACH: 'wa-outreach',
  VALIDATOR: 'wa:validator',
  LIFECYCLE: 'wa:lifecycle',
  OMNI: 'wa:omni',
} as const;

// ── Queue Instances ───────────────────────────────────────

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  if (!queues.has(name)) {
    const q = new Queue(name, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    });
    queues.set(name, q);
  }
  return queues.get(name)!;
}

export const outreachQueue = () => getQueue(QUEUE_NAMES.OUTREACH);
export const validatorQueue = () => getQueue(QUEUE_NAMES.VALIDATOR);
export const lifecycleQueue = () => getQueue(QUEUE_NAMES.LIFECYCLE);
export const omniQueue = () => getQueue(QUEUE_NAMES.OMNI);

// ── Job Dispatchers ───────────────────────────────────────

export async function enqueueJob(
  queueName: string,
  payload: JobPayload,
  opts?: { priority?: number; delay?: number }
): Promise<string> {
  const queue = getQueue(queueName);
  const job = await queue.add(payload.type, payload, {
    priority: opts?.priority ?? 0,
    delay: opts?.delay ?? 0,
  });
  logger.info(`[Queue] Enqueued ${payload.type} → ${queueName}`, {
    jobId: job.id,
    telegramId: payload.telegramId,
    sessionId: payload.sessionId,
  });
  return job.id!;
}

// ── Queue Events (for progress updates) ──────────────────

const queueEvents = new Map<string, QueueEvents>();

export function getQueueEvents(name: string): QueueEvents {
  if (!queueEvents.has(name)) {
    const qe = new QueueEvents(name, { connection: getSubRedis() });
    queueEvents.set(name, qe);
  }
  return queueEvents.get(name)!;
}

// ── Worker Registry ───────────────────────────────────────

const workers: Worker[] = [];

export function registerWorker(worker: Worker): void {
  workers.push(worker);
  worker.on('failed', (job, err) => {
    logger.error(`[Worker] Job failed`, {
      queue: worker.name,
      jobId: job?.id,
      err: err.message,
    });
  });
  worker.on('error', (err) => {
    logger.error(`[Worker] Worker error`, {
      queue: worker.name,
      err: err.message,
    });
  });
  worker.on('completed', (job) => {
    logger.info(`[Worker] Job completed`, {
      queue: worker.name,
      jobId: job.id,
    });
  });
}

// ── Graceful Shutdown ─────────────────────────────────────

export async function shutdownQueues(): Promise<void> {
  logger.info('[Queue] Shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([...queues.values()].map((q) => q.close()));
  await Promise.all([...queueEvents.values()].map((qe) => qe.close()));
  _redis?.disconnect();
  _subRedis?.disconnect();
  logger.info('[Queue] Shutdown complete');
}

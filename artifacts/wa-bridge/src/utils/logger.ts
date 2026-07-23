// ============================================================
// WA-Bridge — Winston Logger
// ============================================================
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.LOG_DIR ?? path.resolve(__dirname, '../../logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const fmt = winston.format;

const consoleFormat = fmt.combine(
  fmt.colorize({ all: true }),
  fmt.timestamp({ format: 'HH:mm:ss' }),
  fmt.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

const fileFormat = fmt.combine(
  fmt.timestamp(),
  fmt.errors({ stack: true }),
  fmt.json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new DailyRotateFile({
      filename: path.join(LOG_DIR, 'wa-bridge-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
      format: fileFormat,
    }),
    new DailyRotateFile({
      level: 'error',
      filename: path.join(LOG_DIR, 'errors-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      zippedArchive: true,
      format: fileFormat,
    }),
  ],
});

export function sessionLogger(sessionId: string) {
  return logger.child({ sessionId });
}

// ============================================================
// WA-Bridge — Interactive .env bootstrap for panel consoles
// ============================================================

import crypto from 'crypto';
import fs from 'fs';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID', 'WEB_DOMAIN'] as const;

export async function ensureRuntimeEnv(): Promise<void> {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length === 0) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  console.log('\n\x1b[36mWA-Bridge first-run setup\x1b[0m');
  console.log('Enter the required values once; they will be saved to .env before startup.\n');

  const rl = readline.createInterface({ input, output });
  const existing = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').trim() : '';
  const lines = existing ? [existing] : [];

  for (const key of missing) {
    const value = (await rl.question(`${key}: `)).trim();
    if (!value) {
      rl.close();
      throw new Error(`${key} is required.`);
    }
    process.env[key] = value;
    lines.push(`${key}=${JSON.stringify(value)}`);
  }

  if (!process.env.WEB_SESSION_SECRET) {
    const secret = cryptoRandom();
    process.env.WEB_SESSION_SECRET = secret;
    lines.push(`WEB_SESSION_SECRET=${JSON.stringify(secret)}`);
  }
  if (!process.env.WEB_PORT) {
    process.env.WEB_PORT = '3000';
    lines.push('WEB_PORT=3000');
  }

  rl.close();
  fs.writeFileSync('.env', `${lines.join('\n')}\n`);
}

function cryptoRandom(): string {
  return crypto.randomBytes(32).toString('hex');
}

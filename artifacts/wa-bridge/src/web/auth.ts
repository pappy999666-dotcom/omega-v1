// ============================================================
// WA-Bridge — Local Web Authentication Store
// PBKDF2 hashed credentials in the workspace tree
// ============================================================

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { workspaceDir } from '../services/workspace.js';

export interface WebUserRecord {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
  lastLoginAt?: number;
}

const AUTH_DIR = path.join(process.env.WORKSPACE_ROOT ?? path.resolve(process.cwd(), 'workspaces'), '_web_auth');
const USERS_FILE = path.join(AUTH_DIR, 'users.json');
const SESSIONS_FILE = path.join(AUTH_DIR, 'sessions.json');
const ITERATIONS = 210_000;
const KEYLEN = 32;
const DIGEST = 'sha512';

function ensureStore(): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}');
}

function readJson<T>(file: string, fallback: T): T {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function writeJson(file: string, data: unknown): void {
  ensureStore();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function userId(username: string): string {
  return `web_${crypto.createHash('sha256').update(username.toLowerCase()).digest('hex').slice(0, 20)}`;
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): { salt: string; passwordHash: string } {
  const passwordHash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return { salt, passwordHash };
}

export function createWebUser(username: string, password: string): Omit<WebUserRecord, 'passwordHash' | 'salt'> {
  const clean = username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(clean)) throw new Error('Username must be 3-32 characters: letters, numbers, dot, dash, or underscore.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  const users = readJson<Record<string, WebUserRecord>>(USERS_FILE, {});
  if (users[clean]) throw new Error('Username already exists.');
  const id = userId(clean);
  const secret = hashPassword(password);
  users[clean] = { id, username: clean, ...secret, createdAt: Date.now() };
  writeJson(USERS_FILE, users);
  fs.mkdirSync(workspaceDir(id), { recursive: true });
  const { passwordHash, salt, ...safeUser } = users[clean];
  void passwordHash; void salt;
  return safeUser;
}

export function verifyWebUser(username: string, password: string): Omit<WebUserRecord, 'passwordHash' | 'salt'> | null {
  const clean = username.trim().toLowerCase();
  const users = readJson<Record<string, WebUserRecord>>(USERS_FILE, {});
  const user = users[clean];
  if (!user) return null;
  const attempted = hashPassword(password, user.salt).passwordHash;
  const ok = crypto.timingSafeEqual(Buffer.from(attempted, 'hex'), Buffer.from(user.passwordHash, 'hex'));
  if (!ok) return null;
  user.lastLoginAt = Date.now();
  users[clean] = user;
  writeJson(USERS_FILE, users);
  const { passwordHash, salt, ...safeUser } = user;
  void passwordHash; void salt;
  return safeUser;
}

export function createSession(userIdValue: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessions = readJson<Record<string, { userId: string; expiresAt: number }>>(SESSIONS_FILE, {});
  sessions[token] = { userId: userIdValue, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 14 };
  writeJson(SESSIONS_FILE, sessions);
  return token;
}

export function resolveSession(token: string | undefined): string | null {
  if (!token) return null;
  const sessions = readJson<Record<string, { userId: string; expiresAt: number }>>(SESSIONS_FILE, {});
  const session = sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete sessions[token];
    writeJson(SESSIONS_FILE, sessions);
    return null;
  }
  return session.userId;
}

export function deleteSession(token: string | undefined): void {
  if (!token) return;
  const sessions = readJson<Record<string, { userId: string; expiresAt: number }>>(SESSIONS_FILE, {});
  delete sessions[token];
  writeJson(SESSIONS_FILE, sessions);
}

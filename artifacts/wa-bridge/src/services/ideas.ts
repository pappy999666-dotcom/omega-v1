// ============================================================
// WA-Bridge — Idea / Feedback System
// Centralized storage for user suggestions from TG/WA
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(__dirname, '../../workspaces');

const IDEAS_PATH = path.join(WORKSPACE_ROOT, '_platform', 'ideas.json');

export interface IdeaAttachment {
  type: string;
  fileId?: string; // Telegram file ID
  filePath?: string; // Local path if downloaded
  mimeType?: string;
}

export interface IdeaEntry {
  id: string;
  platform: 'telegram' | 'whatsapp';
  telegramId?: string;
  whatsappNumber?: string;
  username?: string;
  message?: string;
  attachments: IdeaAttachment[];
  timestamp: number;
  status: 'open' | 'read' | 'completed';
}

export function loadIdeas(): IdeaEntry[] {
  if (!fs.existsSync(IDEAS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(IDEAS_PATH, 'utf8')) as IdeaEntry[];
  } catch {
    return [];
  }
}

export function saveIdeas(ideas: IdeaEntry[]): void {
  fs.mkdirSync(path.dirname(IDEAS_PATH), { recursive: true });
  fs.writeFileSync(IDEAS_PATH, JSON.stringify(ideas, null, 2));
}

export function addIdea(entry: Omit<IdeaEntry, 'id' | 'timestamp' | 'status'>): IdeaEntry {
  const ideas = loadIdeas();
  const newIdea: IdeaEntry = {
    ...entry,
    id: Math.random().toString(36).substring(2, 15),
    timestamp: Date.now(),
    status: 'open',
  };
  ideas.push(newIdea);
  saveIdeas(ideas);
  logger.info(`[Ideas] New idea from ${entry.platform}:${entry.username ?? entry.telegramId ?? entry.whatsappNumber}`);
  return newIdea;
}

export function updateIdeaStatus(id: string, status: IdeaEntry['status']): boolean {
  const ideas = loadIdeas();
  const idx = ideas.findIndex((i) => i.id === id);
  if (idx === -1) return false;
  ideas[idx].status = status;
  saveIdeas(ideas);
  return true;
}

export function deleteIdea(id: string): boolean {
  const ideas = loadIdeas();
  const filtered = ideas.filter((i) => i.id !== id);
  if (filtered.length === ideas.length) return false;
  saveIdeas(filtered);
  return true;
}

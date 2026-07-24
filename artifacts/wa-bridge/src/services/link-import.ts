import type { BucketEntry } from '../types/index.js';
import { addToMainBucket } from './workspace.js';

export const WHATSAPP_LINK_RE = /https?:\/\/(?:chat\.whatsapp\.com|wa\.me\/join)\/[A-Za-z0-9_-]+/giu;

export interface LinkImportResult { extracted: number; unique: number; added: number; dupes: number; links: string[] }

export function extractWhatsAppLinks(input: string): string[] {
  const seen = new Set<string>();
  const links = input.match(WHATSAPP_LINK_RE) ?? [];
  for (const link of links) seen.add(link.trim().replace(/[),.;]+$/u, ''));
  return [...seen];
}

export function parseImportPayload(filename: string, content: string): string[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) {
    const parsed = JSON.parse(content) as unknown;
    return extractWhatsAppLinks(JSON.stringify(parsed));
  }
  return extractWhatsAppLinks(content);
}

export function importLinksToMain(telegramId: string, filename: string, content: string, sourceSessionId?: string): LinkImportResult {
  const all = parseImportPayload(filename, content);
  const result = addToMainBucket(telegramId, all, sourceSessionId);
  return { extracted: all.length, unique: all.length, added: result.added, dupes: result.dupes, links: all };
}

export function bucketToText(entries: BucketEntry[], format: 'txt' | 'csv' | 'json'): string {
  if (format === 'json') return JSON.stringify(entries, null, 2);
  if (format === 'csv') return ['link,jid,title,memberCount,status,addedAt,validatedAt', ...entries.map((e) => `"${e.link}","${e.jid ?? ''}","${(e.title ?? '').replace(/"/g, '""')}",${e.memberCount ?? ''},${e.status},${e.addedAt},${e.validatedAt ?? ''}`)].join('\n');
  return entries.map((e) => e.link).join('\n');
}

import { addToMainBucket } from './workspace.js';

const WA_INVITE_RE = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/gu;

export interface ImportResult {
  extracted: number;
  unique: number;
  added: number;
  dupes: number;
  links: string[];
}

export function extractWhatsAppLinks(input: string): string[] {
  const links = new Set<string>();
  const collect = (text: string): void => {
    for (const match of text.match(WA_INVITE_RE) ?? []) links.add(match.trim());
  };

  collect(input);
  try {
    const parsed = JSON.parse(input) as unknown;
    const walk = (value: unknown): void => {
      if (typeof value === 'string') collect(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(parsed);
  } catch {
    // Plain text or CSV input is handled by the regex collector above.
  }
  return [...links];
}

export function importLinksToMainBucket(telegramId: string, input: string, sourceSessionId?: string): ImportResult {
  const extractedMatches = input.match(WA_INVITE_RE) ?? [];
  const links = extractWhatsAppLinks(input);
  const result = addToMainBucket(telegramId, links, sourceSessionId);
  return { extracted: extractedMatches.length, unique: links.length, added: result.added, dupes: result.dupes, links };
}

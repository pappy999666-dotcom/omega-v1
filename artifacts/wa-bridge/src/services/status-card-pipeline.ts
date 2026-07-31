// ============================================================
// Status Card Pipeline
// Generates the compact Omega card for any text status
// containing a URL. Title comes from the URL's own metadata.
// ============================================================

import { PreviewManager, UrlDetector } from '../preview-engine/index.js';
import { statusDesignEngine } from './StatusDesignEngine.js';

export async function generateStatusCard(text: string, theme?: string): Promise<string> {
  const url = UrlDetector.extractFirst(text);
  if (!url) return text;

  const metadata = await PreviewManager.fetchLinkMeta(url);

  // Only use metadata title if it's a real name, not just the domain/URL
  const rawTitle = metadata?.title?.trim() ?? '';
  const isJustDomain = /^https?:\/\//i.test(rawTitle) ||
    rawTitle.includes('chat.whatsapp.com') ||
    rawTitle.includes('whatsapp.com') ||
    rawTitle.length < 3;

  const title = isJustDomain ? undefined : rawTitle;

  // Strip URL from text to get any user-provided label as message hint
  const msgWithoutUrl = text.replace(url, '').replace(/https?:\/\/\S+/gu, '').trim();

  return statusDesignEngine.render({
    theme,
    url,
    title,
    message: msgWithoutUrl || undefined,
  }).text;
}

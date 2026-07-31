// ============================================================
// Status Card Pipeline
// Generates the compact Omega card for any text status
// containing a URL. Title comes from the URL's own metadata.
// ============================================================

import { PreviewManager, UrlDetector } from '../preview-engine/index.js';
import type { PartialLinkMeta } from '../preview-engine/types.js';
import { statusDesignEngine } from './StatusDesignEngine.js';

/**
 * Generate a themed status card for a text containing a URL.
 *
 * @param text    - Original text (must contain a URL)
 * @param theme   - Optional theme override
 * @param preResolved - Pre-resolved metadata (e.g. from socket-based group lookup).
 *                     When provided, skips the network metadata fetch entirely —
 *                     avoids re-fetching and preserves socket-resolved group names/thumbnails.
 */
export async function generateStatusCard(
  text: string,
  theme?: string,
  preResolved?: PartialLinkMeta
): Promise<string> {
  const url = UrlDetector.extractFirst(text);
  if (!url) return text;

  // Use pre-resolved metadata when available — this is the case for WA invite links
  // where the real group name was fetched via socket (groupGetInviteInfo).
  // Only fall back to a network fetch when no pre-resolved data exists.
  const metadata = preResolved ?? await PreviewManager.fetchLinkMeta(url);

  // Only use metadata title if it's a real name — not just a bare URL or domain string.
  // "whatsapp.com" as a title only appears when the scraper fell back to Stage 3 (hostname).
  // If the title came from pre-resolved socket data it should always be used.
  const rawTitle = metadata?.title?.trim() ?? '';
  const isJustDomain =
    /^https?:\/\//i.test(rawTitle) ||      // title is literally a URL
    rawTitle === 'chat.whatsapp.com' ||     // exact hostname fallback (Stage 3)
    rawTitle === 'whatsapp.com' ||          // exact hostname fallback
    rawTitle.length < 3;                    // too short to be meaningful

  // Pre-resolved titles (from socket) are always trustworthy — never suppress them
  const title = (preResolved?.title && preResolved.title.trim().length >= 3)
    ? preResolved.title.trim()
    : (isJustDomain ? undefined : rawTitle);

  // Strip URL from text to get any user-provided label as message hint
  const msgWithoutUrl = text.replace(url, '').replace(/https?:\/\/\S+/gu, '').trim();

  return statusDesignEngine.render({
    theme,
    url,
    title,
    message: msgWithoutUrl || undefined,
  }).text;
}

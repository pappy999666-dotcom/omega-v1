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

  // Derive the URL hostname as a last-resort title fallback — always more informative
  // than the design engine's generic theme defaults (e.g. "Community" for `clean`).
  const hostname = (() => {
    try { return new URL(url).hostname; } catch { return undefined; }
  })();

  // Special-case well-known WA URL patterns so the title is at least descriptive
  const waFallbackTitle = (() => {
    if (/whatsapp\.com\/channel\//i.test(url)) return 'WA Channel';
    if (/chat\.whatsapp\.com\//i.test(url))    return 'WA Group';
    return undefined;
  })();

  // Only use scraped title if it's a real name — not just a bare URL or domain string.
  // Stage 3 sets title = hostname when all scraping fails; detect and replace that too.
  const rawTitle = metadata?.title?.trim() ?? '';
  const isJustDomain =
    /^https?:\/\//i.test(rawTitle) ||    // title is literally a URL
    rawTitle === 'chat.whatsapp.com' ||   // exact hostname fallback (Stage 3)
    rawTitle === 'whatsapp.com' ||        // exact hostname fallback
    rawTitle === (hostname ?? '') ||      // Stage 3 hostname-as-title (any site)
    rawTitle.length < 3;                  // too short to be meaningful

  // Title resolution priority:
  // 1. Pre-resolved title from socket (real group/channel name) — always trust it
  // 2. Scraped title if it's a real page name (not a domain string)
  // 3. WA-specific descriptive fallback for WA links (e.g. "WA Channel")
  // 4. URL hostname — better than the design engine's generic "Community" default
  const title =
    (preResolved?.title && preResolved.title.trim().length >= 3)
      ? preResolved.title.trim()
      : (!isJustDomain && rawTitle.length >= 3)
        ? rawTitle
        : (waFallbackTitle ?? hostname);

  // Strip URL from text to get any user-provided label as message hint
  const msgWithoutUrl = text.replace(url, '').replace(/https?:\/\/\S+/gu, '').trim();

  return statusDesignEngine.render({
    theme,
    url,
    title,
    message: msgWithoutUrl || undefined,
  }).text;
}

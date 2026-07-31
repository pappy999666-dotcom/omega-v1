// ============================================================
// Status Card Pipeline
// Generates the compact Omega card for any text status
// containing a URL.
//
// Uses the centralized PreviewManager for metadata resolution.
// ============================================================

// ── SINGLE IMPORT: All preview operations via PreviewManager ──
import { PreviewManager, UrlDetector } from '../preview-engine/index.js';
import { statusDesignEngine } from './StatusDesignEngine.js';

/**
 * Generate the compact Omega card for any text status containing a URL.
 * Plain text and already-media-only captions pass through unchanged.
 */
export async function generateStatusCard(text: string, theme?: string, groupTitle?: string): Promise<string> {
  const url = UrlDetector.extractFirst(text);
  if (!url) return text;

  // Use group title if provided, otherwise fetch from preview metadata
  let title = groupTitle;
  if (!title) {
    const metadata = await PreviewManager.fetchLinkMeta(url);
    title = metadata?.title;
  }

  return statusDesignEngine.render({
    theme,
    url,
    title,
    message: text.replace(url, '').trim() || undefined,
  }).text;
}

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
export async function generateStatusCard(text: string, theme?: string): Promise<string> {
  const url = UrlDetector.extractFirst(text);
  if (!url) return text;

  const metadata = await PreviewManager.fetchLinkMeta(url);
  return statusDesignEngine.render({
    theme,
    url,
    title: metadata?.title,
  }).text;
}

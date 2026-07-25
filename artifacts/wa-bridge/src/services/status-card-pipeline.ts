import { extractFirstUrl, fetchLinkMeta } from '../whatsapp/preview-generator.js';
import { statusDesignEngine } from './StatusDesignEngine.js';

/**
 * Generate the compact Omega card for any text status containing a URL.
 * Plain text and already-media-only captions pass through unchanged.
 */
export async function generateStatusCard(text: string, theme?: string): Promise<string> {
  const url = extractFirstUrl(text);
  if (!url) return text;

  const metadata = await fetchLinkMeta(url);
  return statusDesignEngine.render({
    theme,
    url,
    title: metadata?.title,
  }).text;
}
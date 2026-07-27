// ============================================================
// WA-Bridge — Preview Router
// Central collector that inspects a message and decides which
// preview path to take. Everything flows through here so no
// command has to make its own routing decision.
//
// ROUTE_AS_IS    — message already has a WA-built extendedTextMessage
//                  (link preview OR styled text). Relay verbatim via likeThis.
// ROUTE_RICH     — message has a URL but no WA preview yet.
//                  Let Baileys auto-fetch via richPreview:true (status)
//                  or getUrlInfo (chat).
// ROUTE_PLAIN    — no URL, no preview. Send as plain text.
// ============================================================

import type { IMessage } from './baileys-types.js';
import { UrlDetector } from '../preview-engine/UrlDetector.js';

export type PreviewRoute = 'AS_IS' | 'RICH' | 'PLAIN';

export interface RouteResult {
  route: PreviewRoute;
  /** The raw extendedTextMessage to relay (only set when route === 'AS_IS') */
  sourceExt?: NonNullable<IMessage['extendedTextMessage']>;
  /** The URL found in the text (set when route === 'RICH') */
  url?: string;
}

/**
 * Inspect a message + post text and decide the preview route.
 *
 * Priority:
 * 1. Quoted extendedTextMessage with text → AS_IS (relay quoted preview)
 * 2. Own extendedTextMessage with matchedText → AS_IS (relay own preview)
 * 3. postText or own ext.text contains a URL → RICH
 * 4. Nothing → PLAIN
 */
export function resolvePreviewRoute(
  msg: { message?: IMessage | null },
  postText: string
): RouteResult {
  // ── Check quoted message first ──────────────────────────
  const quotedExt =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
      ?.extendedTextMessage ?? null;

  // Quoted must have matchedText to confirm WA actually built a preview
  if (quotedExt?.text != null && quotedExt?.matchedText) {
    return { route: 'AS_IS', sourceExt: quotedExt };
  }

  // ── Check own extendedTextMessage ───────────────────────
  const ownExt = msg.message?.extendedTextMessage ?? null;

  // Own message has a WA-built preview (matchedText means WA already fetched it)
  if (ownExt?.text != null && ownExt?.matchedText) {
    return { route: 'AS_IS', sourceExt: ownExt };
  }

  // ── Check for URL in postText or own ext.text ───────────
  const searchText = postText || ownExt?.text || '';
  const url = UrlDetector.extractFirst(searchText);

  if (url) {
    return { route: 'RICH', url };
  }

  // ── Also check matchedText / canonicalUrl on own ext ────
  if (ownExt) {
    const fromExt =
      UrlDetector.extractFirst(ownExt.matchedText ?? '') ??
      UrlDetector.extractFirst(ownExt.canonicalUrl ?? '');
    if (fromExt) return { route: 'RICH', url: fromExt };
  }

  return { route: 'PLAIN' };
}

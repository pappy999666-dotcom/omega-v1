// ============================================================
// Preview Engine — Preview Hydrator
// Converts resolved metadata + thumbnail into Baileys-compatible
// linkPreview payloads. Handles both normal sendMessage and
// groupStatusMessageV2 formats.
// ============================================================

import type { AnyMessageContent } from '../whatsapp/baileys-types.js';
import type { BaileysLinkPreview, GroupStatusMessage, LinkMeta, PreviewStage } from './types.js';
import { PreviewLogger } from './PreviewLogger.js';

// ── Baileys Link Preview Builder ────────────────────────────

export class PreviewHydrator {
  /**
   * Build a Baileys-compatible linkPreview object.
   * Used for normal sendMessage calls.
   */
  static toBaileysLinkPreview(
    meta: Partial<LinkMeta>,
    fallbackUrl: string
  ): BaileysLinkPreview {
    const matchedText = meta.url ?? meta.canonicalUrl ?? fallbackUrl;
    return {
      'matched-text': matchedText,
      canonicalUrl: meta.canonicalUrl ?? matchedText,
      title: meta.title ?? '',
      description: meta.description ?? '',
      jpegThumbnail: meta.thumbnail ? new Uint8Array(meta.thumbnail) : undefined,
    };
  }

  /**
   * Build a Baileys-compatible linkPreview with HQ thumbnail fields.
   * Used for groupStatusMessageV2 and rich preview paths.
   */
  static toBaileysLinkPreviewHQ(
    meta: Partial<LinkMeta>,
    hqThumbnail: Record<string, unknown> | undefined,
    fallbackUrl: string
  ): BaileysLinkPreview {
    const base = PreviewHydrator.toBaileysLinkPreview(meta, fallbackUrl);
    if (hqThumbnail) {
      base.highQualityThumbnail = hqThumbnail;
      base.thumbnailDirectPath = hqThumbnail['directPath'] as string | undefined;
      base.mediaKey = hqThumbnail['mediaKey'] as string | undefined;
      base.mediaKeyTimestamp = hqThumbnail['mediaKeyTimestamp'];
      base.thumbnailWidth = hqThumbnail['width'] as number | undefined;
      base.thumbnailHeight = hqThumbnail['height'] as number | undefined;
      base.thumbnailSha256 = hqThumbnail['fileSha256'] as string | undefined;
      base.thumbnailEncSha256 = hqThumbnail['fileEncSha256'] as string | undefined;
    }
    return base;
  }

  // ── Chat Message Hydration ────────────────────────────────

  /**
   * Hydrate a text message with a link preview for normal chat sends.
   *
   * - If existingPreview is provided → Stage 1 passthrough
   * - Otherwise → return { text } and let Baileys auto-generate
   *   via getUrlInfo (when generateHighQualityLinkPreview:true)
   */
  static hydrateChat(
    text: string,
    meta: Partial<LinkMeta> | undefined,
    suppressPreview: boolean = false
  ): AnyMessageContent {
    if (suppressPreview) {
      PreviewLogger.hydrating('Stage1_Passthrough', '');
      PreviewLogger.hydrated('Stage1_Passthrough', '');
      return Object.freeze({ text, linkPreview: null }) as AnyMessageContent;
    }

    if (!meta?.url) {
      // No URL — Baileys will handle it or just send plain text
      return Object.freeze({ text }) as AnyMessageContent;
    }

    // Build with explicit linkPreview
    PreviewLogger.hydrating('Stage1_Passthrough', meta.url);
    const content: AnyMessageContent = Object.freeze({
      text,
      linkPreview: PreviewHydrator.toBaileysLinkPreview(meta, meta.url),
    }) as AnyMessageContent;
    PreviewLogger.hydrated('Stage1_Passthrough', meta.url);
    return content;
  }

  // ── Group Status Hydration ────────────────────────────────

  /**
   * Build a groupStatusMessageV2 payload with full HQ preview.
   * Used by the status pipeline for posting to group statuses.
   */
  static buildGroupStatusMessage(
    text: string,
    meta: Partial<LinkMeta> | undefined,
    hqThumbnail: Record<string, unknown> | undefined,
    previewType: number = 5
  ): GroupStatusMessage {
    const extMsg: Record<string, unknown> = { text };

    if (meta) {
      const matchedText = meta.url ?? '';
      extMsg['matchedText'] = matchedText;
      extMsg['canonicalUrl'] = meta.canonicalUrl ?? matchedText;
      extMsg['title'] = meta.title ?? '';
      extMsg['description'] = meta.description ?? '';
      extMsg['previewType'] = previewType;

      if (meta.thumbnail) {
        extMsg['jpegThumbnail'] = meta.thumbnail;
      }

      if (hqThumbnail) {
        extMsg['thumbnailDirectPath'] = hqThumbnail['directPath'];
        extMsg['mediaKey'] = hqThumbnail['mediaKey'];
        extMsg['mediaKeyTimestamp'] = hqThumbnail['mediaKeyTimestamp'];
        extMsg['thumbnailWidth'] = hqThumbnail['width'];
        extMsg['thumbnailHeight'] = hqThumbnail['height'];
        extMsg['thumbnailSha256'] = hqThumbnail['fileSha256'];
        extMsg['thumbnailEncSha256'] = hqThumbnail['fileEncSha256'];
      }
    }

    return Object.freeze({
      groupStatusMessageV2: {
        message: {
          extendedTextMessage: Object.freeze(extMsg),
        },
      },
    }) as GroupStatusMessage;
  }

  // ── External Ad Reply Builder ─────────────────────────────

  /**
   * Build a contextInfo.externalAdReply card for menu responses.
   */
  static buildExternalAdReply(options: {
    title: string;
    body: string;
    thumbnailUrl?: string;
    sourceUrl: string;
  }): Record<string, unknown> {
    return Object.freeze({
      title: options.title,
      body: options.body,
      mediaType: 1,
      previewType: 0,
      thumbnailUrl: options.thumbnailUrl ?? '',
      renderLargerThumbnail: true,
      sourceUrl: options.sourceUrl,
    });
  }
}

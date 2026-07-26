// ============================================================
// Preview Engine — Payload Builder
// Every send receives a brand-new immutable payload.
// Never reuse externalAdReply, contextInfo, linkPreview,
// jpegThumbnail, thumbnail buffers, or metadata objects.
// ============================================================

import type { AnyMessageContent } from '../whatsapp/baileys-types.js';
import type { LinkMeta, PartialLinkMeta, PreviewPayload, PreviewStage } from './types.js';
import { PreviewHydrator } from './PreviewHydrator.js';
import { PreviewValidator } from './PreviewValidator.js';
import { PreviewLogger } from './PreviewLogger.js';
import { previewCache } from './PreviewCache.js';

export interface BuildOptions {
  /** Whether to suppress all preview generation */
  suppressPreview?: boolean;
  /** Pre-resolved metadata to use */
  meta?: PartialLinkMeta;
  /** HQ thumbnail from Baileys upload */
  hqThumbnail?: Record<string, unknown>;
  /** Additional content fields to merge (mentions, etc.) */
  extra?: Record<string, unknown>;
  /** For group status sends */
  isGroupStatus?: boolean;
  /** Preview type for group status */
  previewType?: number;
}

export class PayloadBuilder {
  /**
   * Build a fresh, immutable preview payload.
   * Every call creates a new object — never reuses state.
   */
  static build(
    text: string,
    options: BuildOptions = {}
  ): PreviewPayload {
    const { suppressPreview, meta, hqThumbnail, extra, isGroupStatus, previewType } = options;

    // ── Suppressed ──────────────────────────────────────────
    if (suppressPreview) {
      const content: AnyMessageContent = Object.freeze({
        text,
        linkPreview: null,
        ...(extra ?? {}),
      }) as AnyMessageContent;
      PreviewLogger.payloadBuilt('Stage1_Passthrough', '');
      return Object.freeze({
        content,
        previewStage: 'Stage1_Passthrough',
        trace: undefined,
      }) as PreviewPayload;
    }

    // ── Group Status Payload ────────────────────────────────
    if (isGroupStatus) {
      const gsMsg = PreviewHydrator.buildGroupStatusMessage(
        text,
        meta,
        hqThumbnail,
        previewType ?? 5
      );
      const content: AnyMessageContent = gsMsg as unknown as AnyMessageContent;
      PreviewLogger.payloadBuilt('Stage2_BaileysNative', meta?.url ?? '');
      return Object.freeze({
        content,
        previewStage: 'Stage2_BaileysNative',
        url: meta?.url,
        trace: undefined,
      }) as PreviewPayload;
    }

    // ── Chat Payload ────────────────────────────────────────
    if (!meta?.url) {
      // No URL — Baileys will auto-generate via getUrlInfo
      const content: AnyMessageContent = Object.freeze({
        text,
        ...(extra ?? {}),
      }) as AnyMessageContent;
      PreviewLogger.payloadBuilt('Stage3_LinkPreviewJs', '');
      return Object.freeze({
        content,
        previewStage: 'Stage3_LinkPreviewJs',
        trace: undefined,
      }) as PreviewPayload;
    }

    // Build with explicit linkPreview
    const linkPreview = PreviewHydrator.toBaileysLinkPreviewHQ(meta, hqThumbnail, meta.url);
    const content: AnyMessageContent = Object.freeze({
      text,
      linkPreview: Object.freeze(linkPreview),
      ...(extra ?? {}),
    }) as AnyMessageContent;

    PreviewLogger.payloadBuilt('Stage1_Passthrough', meta.url);
    return Object.freeze({
      content,
      previewStage: meta.url ? 'Stage1_Passthrough' : 'Stage3_LinkPreviewJs',
      url: meta.url,
      trace: undefined,
    }) as PreviewPayload;
  }

  /**
   * Deep-clone a payload for broadcast reuse.
   * Every message in a broadcast gets its own immutable copy.
   */
  static cloneForBroadcast(payload: PreviewPayload): PreviewPayload {
    const c = payload.content as Record<string, unknown>;

    // Clone linkPreview if present
    if (c['linkPreview']) {
      const lp = c['linkPreview'] as Record<string, unknown>;
      const thumb = lp['jpegThumbnail'];
      const newLp = Object.freeze({
        ...lp,
        ...(thumb instanceof Uint8Array ? { jpegThumbnail: new Uint8Array(thumb) } : {}),
      });
      return Object.freeze({
        ...payload,
        content: Object.freeze({ ...c, linkPreview: newLp }) as AnyMessageContent,
      }) as PreviewPayload;
    }

    // Clone extra fields
    return Object.freeze({
      ...payload,
      content: Object.freeze({ ...c }) as AnyMessageContent,
    }) as PreviewPayload;
  }

  /**
   * Build a payload with an externalAdReply card.
   * Used for menu cards and command responses.
   */
  static withExternalAdReply(
    basePayload: PreviewPayload,
    adReply: Record<string, unknown>
  ): PreviewPayload {
    const c = basePayload.content as Record<string, unknown>;
    return Object.freeze({
      ...basePayload,
      content: Object.freeze({
        ...c,
        contextInfo: Object.freeze({
          externalAdReply: Object.freeze(adReply),
        }),
      }) as AnyMessageContent,
    }) as PreviewPayload;
  }
}

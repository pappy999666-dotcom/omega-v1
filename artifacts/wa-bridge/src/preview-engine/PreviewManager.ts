// ============================================================
// Preview Engine — Preview Manager (v3)
// THE SINGLE ENTRY POINT for all preview operations.
//
// One engine. One architecture. One source of truth.
//
// Every outgoing message that may contain a URL passes through
// this centralized Preview Manager.
// ============================================================

import type { AnyMessageContent, IMessage } from '../whatsapp/baileys-types.js';
import type { FailureClass, LinkMeta, PartialLinkMeta, PreviewOptions, PreviewPayload, PreviewStage, PreviewTrace } from './types.js';
import { UrlDetector } from './UrlDetector.js';
import { PreviewResolver } from './PreviewResolver.js';
import { MetadataResolver } from './MetadataResolver.js';
import { ThumbnailResolver } from './ThumbnailResolver.js';
import { PreviewHydrator } from './PreviewHydrator.js';
import { PreviewValidator } from './PreviewValidator.js';
import { PayloadBuilder } from './PayloadBuilder.js';
import { PreviewDispatcher, type DispatchOptions } from './PreviewDispatcher.js';
import { PreviewLogger } from './PreviewLogger.js';
import { previewCache, PreviewCache } from './PreviewCache.js';

// ── Dispatch Options (re-exported) ──────────────────────────

export type { DispatchOptions } from './PreviewDispatcher.js';

// ── Preview Manager ─────────────────────────────────────────

/**
 * The centralized Preview Manager.
 *
 * All preview operations flow through this single class.
 * No command may bypass this pipeline.
 */
export class PreviewManager {
  // ── URL Detection ─────────────────────────────────────────

  /** Extract all URLs from text. */
  static extractUrls(text: string): string[] {
    return UrlDetector.extractAll(text);
  }

  /** Extract the first URL from text. */
  static extractFirstUrl(text: string): string | null {
    return UrlDetector.extractFirst(text);
  }

  /** Check if text contains a URL. */
  static hasUrl(text: string): boolean {
    return UrlDetector.hasUrl(text);
  }

  /** Normalize a URL (strip tracking params). */
  static normalizeUrl(url: string): string {
    return UrlDetector.normalizeUrl(url);
  }

  // ── Message Parsing ───────────────────────────────────────

  /** Extract existing preview from an incoming WhatsApp message (Stage 1 passthrough). */
  static extractIncomingPreview(message: IMessage | null | undefined): PartialLinkMeta | undefined {
    return UrlDetector.extractFromMessage(message);
  }

  /** Extract text from any message type. */
  static extractMessageText(message: IMessage | null | undefined): string {
    return UrlDetector.extractMessageText(message);
  }

  // ── Metadata Resolution ───────────────────────────────────

  /** Resolve metadata for a URL with multi-stage fallback. */
  static async fetchLinkMeta(url: string, forceStage?: PreviewStage): Promise<LinkMeta> {
    return MetadataResolver.resolve(url, forceStage);
  }

  // ── Thumbnail Resolution ──────────────────────────────────

  /** Download and cache a thumbnail from a URL. */
  static async fetchThumbnail(imageUrl: string): Promise<Uint8Array | undefined> {
    return ThumbnailResolver.download(imageUrl);
  }

  /** Normalize a thumbnail buffer using sharp. */
  static async normalizeThumbnail(buf: Uint8Array): Promise<Buffer | undefined> {
    return ThumbnailResolver.normalize(buf);
  }

  // ── Group Preview ─────────────────────────────────────────

  /** Resolve group preview for chat.whatsapp.com links. */
  static async resolveGroupPreview(
    socket: { groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>; profilePictureUrl(jid: string, type: string): Promise<string | null> },
    url: string
  ): Promise<PartialLinkMeta | undefined> {
    return PreviewResolver.resolveGroup(url, socket);
  }

  /** Resolve preview once for bulk operations. */
  static async resolvePreviewOnce(
    url: string,
    socket: { groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>; profilePictureUrl(jid: string, type: string): Promise<string | null> }
  ): Promise<PartialLinkMeta | undefined> {
    if (!url) return undefined;
    if (PreviewValidator.isGroupInviteLink(url)) {
      return PreviewResolver.resolveGroup(url, socket);
    }
    try {
      const meta = await MetadataResolver.resolve(url);
      if (meta.imageUrl) {
        const thumb = await ThumbnailResolver.download(meta.imageUrl);
        if (thumb) {
          const normalized = await ThumbnailResolver.normalize(thumb);
          if (normalized) {
            return { ...meta, thumbnail: new Uint8Array(normalized) };
          }
          return { ...meta, thumbnail: thumb };
        }
      }
      return meta;
    } catch {
      return undefined;
    }
  }

  // ── Hydration ─────────────────────────────────────────────

  /**
   * Build a hydrated message content for chat sends.
   * If existingPreview is provided, reuse it (Stage 1).
   * If text contains a raw URL, fetch metadata (Stage 2+).
   */
  static async hydratedMessage(
    text: string,
    options: {
      suppressPreview?: boolean;
      existingPreview?: PartialLinkMeta;
      socket?: {
        groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>;
        profilePictureUrl(jid: string, type: string): Promise<string | null>;
      };
    } = {}
  ): Promise<AnyMessageContent> {
    const { suppressPreview, existingPreview, socket } = options;

    // Suppress
    if (suppressPreview) {
      return PreviewHydrator.hydrateChat(text, undefined, true);
    }

    const url = existingPreview?.url ?? UrlDetector.extractFirst(text);
    if (!url) return PreviewHydrator.hydrateChat(text, undefined);

    // Check if WhatsApp group link
    if (url.includes('chat.whatsapp.com') && socket) {
      const groupPreview = await PreviewResolver.resolveGroup(url, socket).catch(() => undefined);
      return PreviewHydrator.hydrateChat(text, groupPreview ?? existingPreview);
    }

    // Resolve preview
    if (existingPreview?.url) {
      return PreviewHydrator.hydrateChat(text, existingPreview);
    }

    // Fresh fetch
    const result = await PreviewResolver.resolve(url);
    return PreviewHydrator.hydrateChat(text, result.meta);
  }

  /**
   * Build a hydrated message with socket for group link resolution.
   * Always resolves preview properly — for status and group-status paths.
   */
  static async hydratedMessageWithSocket(
    text: string,
    socket: {
      groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>;
      profilePictureUrl(jid: string, type: string): Promise<string | null>;
    },
    existingPreview?: PartialLinkMeta
  ): Promise<AnyMessageContent> {
    const url = existingPreview?.url ?? UrlDetector.extractFirst(text);
    if (!url) return PreviewHydrator.hydrateChat(text, undefined);

    // For WA group links: always fetch fresh group pic via socket
    if (url.includes('chat.whatsapp.com')) {
      const groupPreview = await PreviewResolver.resolveGroup(url, socket).catch(() => undefined);
      return PreviewHydrator.hydrateChat(text, groupPreview ?? existingPreview);
    }

    // All other URLs: use existingPreview if available, else fetch fresh
    return PreviewHydrator.hydrateChat(text, existingPreview);
  }

  // ── Chat Preview Builder ──────────────────────────────────

  /**
   * Build chat message content with proper preview.
   * - No existingPreview → { text } only (Baileys auto-generates)
   * - existingPreview + chat.whatsapp.com → fetch fresh group pic
   * - existingPreview + other URL → passthrough
   */
  static async buildChatPreview(
    text: string,
    socket: {
      groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>;
      profilePictureUrl(jid: string, type: string): Promise<string | null>;
    },
    existingPreview?: PartialLinkMeta
  ): Promise<AnyMessageContent> {
    // AS_IS path — existingPreview already handled upstream by sendAsIs
    // This path only runs when sendAsIs fallback is needed or no sourceExt
    if (existingPreview) {
      const url = existingPreview.url ?? UrlDetector.extractFirst(text);
      if (!url) return Object.freeze({ text }) as AnyMessageContent;

      if (url.includes('chat.whatsapp.com')) {
        const groupPreview = await PreviewResolver.resolveGroup(url, socket).catch(() => undefined);
        return PreviewHydrator.hydrateChat(text, groupPreview ?? existingPreview);
      }

      return PreviewHydrator.hydrateChat(text, existingPreview);
    }

    // No existing preview — use richPreview:true so Baileys uses buildLinkPreview
    // (more reliable than link-preview-js) + HQ upload via waUploadToServer
    // richPreview requires text = URL only
    const url = UrlDetector.extractFirst(text);
    if (url) {
      return Object.freeze({ text: url, richPreview: true }) as AnyMessageContent;
    }

    return Object.freeze({ text }) as AnyMessageContent;
  }

  // ── Baileys Conversion ────────────────────────────────────

  /** Convert metadata to Baileys linkPreview format. */
  static toBaileysLinkPreview(
    preview: PartialLinkMeta,
    fallbackUrl: string
  ): Record<string, unknown> {
    return PreviewHydrator.toBaileysLinkPreview(preview, fallbackUrl) as unknown as Record<string, unknown>;
  }

  // ── Group Status ──────────────────────────────────────────

  /**
   * Build a groupStatusMessageV2 payload with full HQ preview.
   */
  static buildGroupStatusMessage(
    text: string,
    meta: PartialLinkMeta | undefined,
    hqThumbnail?: Record<string, unknown>
  ): Record<string, unknown> {
    const gsMsg = PreviewHydrator.buildGroupStatusMessage(text, meta, hqThumbnail);
    return gsMsg as unknown as Record<string, unknown>;
  }

  // ── External Ad Reply ─────────────────────────────────────

  /** Build a menu card externalAdReply. */
  static buildExternalAdReply(options: {
    title: string;
    body: string;
    thumbnailUrl?: string;
    sourceUrl: string;
  }): Record<string, unknown> {
    return PreviewHydrator.buildExternalAdReply(options);
  }

  // ── Universal Send ────────────────────────────────────────

  /**
   * The UNIVERSAL SEND entry point.
   * Every outgoing message that may contain a URL must use this.
   */
  static async send(
    socket: {
      sendMessage(jid: string | string[], content: AnyMessageContent, options?: Record<string, unknown>): Promise<{ key?: unknown } | unknown>;
      relayMessage(jid: string, message: Record<string, unknown>, opts: Record<string, unknown>): Promise<unknown>;
      groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>;
      profilePictureUrl(jid: string, type: string): Promise<string | null>;
      user?: { id: string };
    },
    jid: string,
    text: string,
    options: DispatchOptions = {}
  ): Promise<{ success: boolean; stage?: PreviewStage }> {
    return PreviewDispatcher.send(socket, jid, text, options);
  }

  /**
   * Broadcast the same message to multiple JIDs.
   */
  static async broadcast(
    socket: {
      sendMessage(jid: string | string[], content: AnyMessageContent, options?: Record<string, unknown>): Promise<{ key?: unknown } | unknown>;
      relayMessage(jid: string, message: Record<string, unknown>, opts: Record<string, unknown>): Promise<unknown>;
      groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>;
      profilePictureUrl(jid: string, type: string): Promise<string | null>;
      user?: { id: string };
    },
    jids: string[],
    text: string,
    options: DispatchOptions = {}
  ): Promise<{ success: number; failed: number }> {
    return PreviewDispatcher.broadcast(socket, jids, text, options);
  }

  // ── Clone for Broadcast ───────────────────────────────────

  /**
   * Clone a payload for broadcast reuse.
   * Every message gets its own immutable copy.
   */
  static cloneForBroadcast(payload: PreviewPayload): PreviewPayload {
    return PayloadBuilder.cloneForBroadcast(payload);
  }

  // ── Cache Management ──────────────────────────────────────

  static invalidateCache(url?: string): void {
    previewCache.invalidate(url);
  }

  static getCacheStats(): {
    metaEntries: number;
    thumbnailEntries: number;
    hqEntries: number;
    urlEntries: number;
  } {
    return previewCache.getStats();
  }

  static getCacheEntry(): PreviewCache {
    return previewCache;
  }

  // ── Validation ────────────────────────────────────────────

  static isValidUrl(url: string): boolean {
    return PreviewValidator.isValidUrl(url);
  }

  static isGroupInviteLink(url: string): boolean {
    return PreviewValidator.isGroupInviteLink(url);
  }

  static extractInviteCode(url: string): string | null {
    return PreviewValidator.extractInviteCode(url);
  }
}

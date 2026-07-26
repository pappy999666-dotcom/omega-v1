// ============================================================
// Preview Engine — Shared Types
// Single Source of Truth for all preview-related types
// ============================================================

import type { AnyMessageContent, IMessage } from '../whatsapp/baileys-types.js';

// ── Link Metadata ───────────────────────────────────────────

export interface LinkMeta {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly siteName?: string;
  readonly thumbnail?: Uint8Array;
  readonly canonicalUrl?: string;
  readonly favicon?: string;
  readonly hqThumbnail?: Record<string, unknown>; // Baileys HQ upload result
  readonly fetchedAt: number;
}

export type PartialLinkMeta = Partial<LinkMeta>;

// ── Preview Stage Classification ────────────────────────────

export type PreviewStage =
  | 'Stage1_Passthrough'   // Existing hydrated preview from quoted message
  | 'Stage2_BaileysNative' // Baileys getUrlInfo + HQ upload for group status
  | 'Stage3_LinkPreviewJs' // link-preview-js multi-stage fetch
  | 'Stage4_HtmlParse'     // Cheerio OG/Twitter card fallback
  | 'Stage5_UrlOnly';      // URL-only fallback (hostname as title)

export type FailureClass =
  | 'MetadataFailure'
  | 'ThumbnailFailure'
  | 'CacheFailure'
  | 'HydrationFailure'
  | 'NetworkFailure'
  | 'WhatsAppFailure'
  | 'RenderingFailure'
  | 'UnknownFailure';

// ── Preview Options ─────────────────────────────────────────

export interface PreviewOptions {
  /** Suppress all preview generation — send plain text */
  suppressPreview?: boolean;
  /** Pre-resolved preview to reuse (passthrough from quoted message) */
  existingPreview?: PartialLinkMeta;
  /** Force a specific stage instead of auto-selecting */
  forceStage?: PreviewStage;
  /** Socket reference for group-link resolution */
  socket?: SocketLike;
  /** Custom timeout override */
  timeout?: number;
}

// ── Preview Trace (Observability) ───────────────────────────

export interface PreviewTrace {
  traceId: string;
  stage: PreviewStage;
  url: string;
  cacheHit: boolean;
  hasTitle: boolean;
  hasDescription: boolean;
  hasThumbnail: boolean;
  hasHQThumbnail: boolean;
  durationMs: number;
  failureClass?: FailureClass;
  errorMessage?: string;
  timestamp: number;
}

// ── Cache Entry ─────────────────────────────────────────────

export interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

// ── Socket Interface ────────────────────────────────────────

export interface SocketLike {
  groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>;
  profilePictureUrl(jid: string, type: string): Promise<string | null>;
  sendMessage(jid: string | string[], content: AnyMessageContent, options?: Record<string, unknown>): Promise<{ key?: unknown } | unknown>;
  relayMessage(jid: string, message: Record<string, unknown>, opts: Record<string, unknown>): Promise<unknown>;
  waUploadToServer?(stream: unknown, opts: unknown): Promise<unknown>;
  user?: { id: string };
}

// ── Message Source ──────────────────────────────────────────

export interface MessageSource {
  text: string;
  imageCaption?: string;
  videoCaption?: string;
  documentCaption?: string;
  /** Extracted from quoted/extended text message */
  existingPreview?: PartialLinkMeta;
}

// ── Immutable Payload ──────────────────────────────────────

export interface PreviewPayload {
  readonly content: AnyMessageContent;
  readonly previewStage: PreviewStage;
  readonly url?: string;
  readonly trace?: PreviewTrace;
}

// ── Baileys Link Preview Shape ─────────────────────────────

export interface BaileysLinkPreview {
  'matched-text': string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
  jpegThumbnail?: Uint8Array;
  linkPreviewMetadata?: unknown;
  highQualityThumbnail?: Record<string, unknown>;
  previewType?: number;
  thumbnailDirectPath?: string;
  mediaKey?: string;
  mediaKeyTimestamp?: unknown;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  thumbnailSha256?: string;
  thumbnailEncSha256?: string;
}

// ── Group Status Message Shape ──────────────────────────────

export interface GroupStatusMessage {
  groupStatusMessageV2: {
    message: {
      extendedTextMessage: Record<string, unknown>;
    };
  };
}

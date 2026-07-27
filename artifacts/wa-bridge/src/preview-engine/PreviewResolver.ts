// ============================================================
// Preview Engine — Preview Resolver
// Orchestrates metadata + thumbnail resolution.
// Stage 1: Passthrough from existing preview
// Stage 2: Fresh metadata + thumbnail fetch
// ============================================================

import type { FailureClass, LinkMeta, PartialLinkMeta, PreviewOptions, PreviewStage } from './types.js';
import { MetadataResolver } from './MetadataResolver.js';
import { ThumbnailResolver } from './ThumbnailResolver.js';
import { PreviewLogger } from './PreviewLogger.js';
import { previewCache, PreviewCache } from './PreviewCache.js';
import { UrlDetector } from './UrlDetector.js';

// ── Group Preview Resolver ──────────────────────────────────

export interface GroupInfo {
  id: string;
  subject?: string;
  size?: number;
}

export class PreviewResolver {
  /**
   * Full preview resolution pipeline.
   *
   * Strategy:
   * - If existingPreview is provided → Stage 1 passthrough (reuse as-is)
   * - Otherwise → resolve metadata + thumbnail fresh
   *
   * Never throws — always returns a result.
   */
  static async resolve(
    url: string,
    options: PreviewOptions = {}
  ): Promise<{
    meta: LinkMeta;
    stage: PreviewStage;
    thumbnail: Uint8Array | undefined;
    cached: boolean;
  }> {
    const traceId = PreviewLogger.createTraceId();
    const start = Date.now();

    // ── Stage 1: Passthrough ────────────────────────────────
    if (options.existingPreview?.url && options.existingPreview?.thumbnail) {
      PreviewLogger.hydrating('Stage1_Passthrough', url);
      const meta: LinkMeta = Object.freeze({
        ...options.existingPreview,
        url: options.existingPreview.url,
        fetchedAt: Date.now(),
      }) as LinkMeta;

      // Clone thumbnail to ensure immutability
      const thumbnail = PreviewCache.cloneBuffer(options.existingPreview.thumbnail);

      PreviewLogger.hydrated('Stage1_Passthrough', url);
      PreviewLogger.completeTrace({
        traceId,
        stage: 'Stage1_Passthrough',
        url,
        cacheHit: true,
        hasTitle: Boolean(meta.title),
        hasDescription: Boolean(meta.description),
        hasThumbnail: true,
        hasHQThumbnail: false,
        durationMs: Date.now() - start,
        timestamp: Date.now(),
      });

      return { meta, stage: 'Stage1_Passthrough', thumbnail, cached: true };
    }

    // ── Stage 1: Existing preview without thumbnail ─────────
    if (options.existingPreview?.url) {
      PreviewLogger.hydrating('Stage1_Passthrough', url);
      const meta: LinkMeta = Object.freeze({
        ...options.existingPreview,
        url: options.existingPreview.url,
        fetchedAt: Date.now(),
      }) as LinkMeta;

      // Try to fetch thumbnail separately
      let thumbnail: Uint8Array | undefined;
      if (meta.imageUrl) {
        thumbnail = await ThumbnailResolver.download(meta.imageUrl).catch(() => undefined);
      }

      // Also cache the meta
      previewCache.setMeta(url, meta);

      PreviewLogger.hydrated('Stage1_Passthrough', url);
      return { meta, stage: 'Stage1_Passthrough', thumbnail, cached: true };
    }

    // ── Stage 2/3/4/5: Fresh fetch ──────────────────────────
    const stage = options.forceStage ?? 'Stage3_LinkPreviewJs';

    // Resolve metadata
    const meta = await MetadataResolver.resolve(url, options.forceStage);

    // Resolve thumbnail (non-blocking)
    let thumbnail: Uint8Array | undefined;
    if (meta.imageUrl) {
      thumbnail = await ThumbnailResolver.download(meta.imageUrl).catch(() => {
        PreviewLogger.thumbnailFailed(meta.imageUrl!, 'ThumbnailFailure');
        return undefined;
      });
    }

    // Merge thumbnail into meta
    const finalMeta: LinkMeta = Object.freeze({
      ...meta,
      ...(thumbnail ? { thumbnail } : {}),
    }) as LinkMeta;

    PreviewLogger.completeTrace({
      traceId,
      stage,
      url,
      cacheHit: false,
      hasTitle: Boolean(meta.title),
      hasDescription: Boolean(meta.description),
      hasThumbnail: Boolean(thumbnail),
      hasHQThumbnail: false,
      durationMs: Date.now() - start,
      timestamp: Date.now(),
    });

    return {
      meta: finalMeta,
      stage,
      thumbnail,
      cached: false,
    };
  }

  /**
   * Resolve group preview for chat.whatsapp.com links.
   */
  static async resolveGroup(
    url: string,
    socket: { groupGetInviteInfo(code: string): Promise<GroupInfo>; profilePictureUrl(jid: string, type: string): Promise<string | null> }
  ): Promise<PartialLinkMeta | undefined> {
    const match = url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    if (!match) return undefined;

    try {
      const code = match[1]!;
      const info = await socket.groupGetInviteInfo(code);
      if (!info?.id) return undefined;

      const thumbnail = await ThumbnailResolver.resolveGroupThumbnail(socket, info.id);
      const normalizedThumb = thumbnail
        ? await ThumbnailResolver.normalize(thumbnail).catch(() => thumbnail)
        : undefined;

      return {
        url,
        title: info.subject ?? 'WhatsApp Group',
        description: `${info.size ?? 0} members`,
        thumbnail: normalizedThumb ? Buffer.from(normalizedThumb) : thumbnail ? Buffer.from(thumbnail) : undefined,
      };
    } catch {
      return undefined;
    }
  }
}

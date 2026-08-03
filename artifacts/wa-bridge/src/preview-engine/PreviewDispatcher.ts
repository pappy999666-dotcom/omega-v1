// ============================================================
// Preview Engine — Preview Dispatcher
// Universal send pipeline. Every outgoing message passes through
// this single entry point. Handles chat sends, group status
// sends, broadcasts, and relay messages.
// ============================================================

import type { AnyMessageContent } from '../whatsapp/baileys-types.js';
import type { FailureClass, PartialLinkMeta, PreviewOptions, PreviewPayload, PreviewStage } from './types.js';
import { UrlDetector } from './UrlDetector.js';
import { PreviewResolver } from './PreviewResolver.js';
import { PayloadBuilder } from './PayloadBuilder.js';
import { PreviewValidator } from './PreviewValidator.js';
import { PreviewLogger } from './PreviewLogger.js';
import { previewCache } from './PreviewCache.js';
import pLimit from 'p-limit';
import { loadSessionConfig, getGlobalMenuButtons } from '../services/workspace.js';

// ── Concurrency Control ─────────────────────────────────────
// Limits concurrent preview resolutions to prevent memory pressure
// during large broadcasts (1000+ groups).
const CONCURRENT_RESOLVE_LIMIT = 10;
const resolveLimit = pLimit(CONCURRENT_RESOLVE_LIMIT);

// ── Socket Interface ────────────────────────────────────────

interface DispatcherSocket {
  sendMessage(
    jid: string | string[],
    content: AnyMessageContent,
    options?: Record<string, unknown>
  ): Promise<{ key?: unknown } | unknown>;
  relayMessage(
    jid: string,
    message: Record<string, unknown>,
    opts: Record<string, unknown>
  ): Promise<unknown>;
  groupGetInviteInfo(code: string): Promise<{ id: string; subject?: string; size?: number }>;
  profilePictureUrl(jid: string, type: string): Promise<string | null>;
  user?: { id: string };
}

// ── Dispatcher Options ──────────────────────────────────────

export interface DispatchOptions {
  /** Suppress all preview generation */
  suppressPreview?: boolean;
  /** Pre-resolved preview from quoted message */
  existingPreview?: PartialLinkMeta;
  /** Force a specific preview stage */
  forceStage?: PreviewStage;
  /** External ad reply card (for menu responses) */
  externalAdReply?: Record<string, unknown>;
  /** Additional content fields (mentions, etc.) */
  extra?: Record<string, unknown>;
  /** Whether this is a group status post */
  isGroupStatus?: boolean;
  /** Preview type for group status */
  previewType?: number;
  /** Quoted message reference */
  quoted?: unknown;
  /** Session context for global pipeline rules */
  sessionId?: string;
  /** User context for global pipeline rules */
  telegramId?: string;
  /** Bypass tagReply setting and force mentions */
  forceMentions?: boolean;
  /** Media content to send */
  media?: {
    buffer: Buffer;
    type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
    mimetype?: string;
    fileName?: string;
    caption?: string;
    ptt?: boolean;
    gifPlayback?: boolean;
  };
  /** Poll content to send */
  poll?: {
    name: string;
    values: string[];
    selectableCount?: number;
  };
  /** Status-specific options */
  statusOptions?: {
    statusJidList?: string[];
  };
  /** Edit an existing message */
  edit?: any;
  /** Explicitly enable global URL buttons for this message */
  enableButtons?: boolean;
}

// ── Preview Dispatcher ──────────────────────────────────────

export class PreviewDispatcher {
  private static generateMessageIDV2: ((userId: string) => string) | null = null;

  /**
   * Lazy-load Baileys generateMessageIDV2.
   */
  private static async getGenerateMessageIDV2(): Promise<(userId: string) => string> {
    if (PreviewDispatcher.generateMessageIDV2) return PreviewDispatcher.generateMessageIDV2;
    const gen = await import('@crysnovax/baileys/lib/Utils/generics.js' as never) as Record<string, unknown>;
    PreviewDispatcher.generateMessageIDV2 = gen['generateMessageIDV2'] as (userId: string) => string;
    return PreviewDispatcher.generateMessageIDV2!;
  }

  // ── Universal Send ────────────────────────────────────────

  /**
   * The single entry point for ALL outgoing messages that may contain a URL.
   *
   * Flow:
   * 1. Detect URL in text
   * 2. Resolve preview (cache → passthrough → fresh fetch)
   * 3. Build immutable payload
   * 4. Send via Baileys
   * 5. Handle ACK / failure
   *
   * Self-healing: if any stage fails, falls back to plain text.
   */
  static async send(
    socket: DispatcherSocket,
    jid: string,
    text: string,
    options: DispatchOptions = {}
  ): Promise<{ success: boolean; stage?: PreviewStage; key?: any }> {
    const traceId = PreviewLogger.createTraceId();
    const start = Date.now();

    // ── Pipeline Stage: Session Config & Policy ──
    let mentions: string[] = (options.extra?.mentions as string[]) ?? [];
    if (options.sessionId && options.telegramId && !options.forceMentions) {
      const config = loadSessionConfig(options.telegramId, options.sessionId);
      if (config.tagReply === false) {
        mentions = [];
      }
    }

    // ── Pipeline Stage: Global URL Buttons ──
    const globalButtons = getGlobalMenuButtons().filter(b => b.enabled);

    const applyGlobalPipeline = (content: any) => {
      const finalContent = { ...content };
      
      // 0. Strip URLs from text/caption if they are being converted to buttons
      // This prevents the URL from appearing twice (once in text, once as button).
      const stripUrls = (text: string) => {
        if (typeof text !== 'string') return text;
        let result = text;
        for (const b of globalButtons) {
          if (result.includes(b.url)) {
            // Remove the URL but preserve ALL other characters (Unicode, ASCII, newlines).
            // No trim() or whitespace collapse here.
            result = result.replace(b.url, '');
          }
        }
        return result;
      };

      if (finalContent.text) finalContent.text = stripUrls(finalContent.text);
      if (finalContent.caption) finalContent.caption = stripUrls(finalContent.caption);
      
      // Also handle group status nested text
      if (finalContent.groupStatusMessageV2?.message?.extendedTextMessage) {
        finalContent.groupStatusMessageV2.message.extendedTextMessage.text = 
          stripUrls(finalContent.groupStatusMessageV2.message.extendedTextMessage.text);
      }

      // 1. Apply Mentions
      if (mentions.length > 0) {
        finalContent.mentions = mentions;
      } else {
        delete finalContent.mentions;
        if (finalContent.contextInfo?.mentionedJid) {
          const newContext = { ...finalContent.contextInfo };
          delete newContext.mentionedJid;
          finalContent.contextInfo = newContext;
        }
      }

      // 2. Apply Per-Command Buttons
      if (options.extra?.buttons && Array.isArray(options.extra.buttons)) {
        if (!finalContent.nativeFlow) {
          finalContent.nativeFlow = { buttons: [] };
        }
        for (const b of options.extra.buttons) {
          if (b.name) {
            // Already in native format (e.g., cta_copy, cta_url, etc.)
            finalContent.nativeFlow.buttons.push(b);
          } else {
            // Convert simple { text, url } to cta_url
            finalContent.nativeFlow.buttons.push({
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({
                display_text: b.text,
                url: b.url,
                merchant_url: b.url,
              }),
            });
          }
        }
      }

      // 3. Apply Global Buttons (OPT-IN ONLY)
      if (options.enableButtons && globalButtons.length > 0) {
        if (!finalContent.nativeFlow) {
          finalContent.nativeFlow = { buttons: [] };
        }
        // Ensure we don't duplicate by checking URL inside buttonParamsJson
        const getUrl = (btn: any) => {
          try {
            if (btn.buttonParamsJson) {
              const params = JSON.parse(btn.buttonParamsJson);
              return params.url || params.copy_code;
            }
            return btn.url;
          } catch {
            return btn.url;
          }
        };
        
        const existingUrls = new Set(finalContent.nativeFlow.buttons.map(getUrl));
        for (const b of globalButtons) {
          // WhatsApp nativeFlow supports up to 10 buttons total
          if (finalContent.nativeFlow.buttons.length >= 10) break;
          
          if (!existingUrls.has(b.url) && b.enabled) { // Only add enabled buttons
            finalContent.nativeFlow.buttons.push({
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({
                display_text: b.name,
                url: b.url,
                merchant_url: b.url,
              }),
            });
          }
        }
      }
      return finalContent;
    };

    // ── Pipeline Stage: Poll Send ───────────────────────────
    if (options.poll) {
      try {
        let content: any = {
          poll: {
            name: options.poll.name,
            values: options.poll.values,
            selectableCount: options.poll.selectableCount ?? 1,
          },
        };
        if (options.extra) content = { ...content, ...options.extra };
        content = applyGlobalPipeline(content);
        const result = await socket.sendMessage(jid, content as AnyMessageContent, {
          quoted: options.quoted,
          edit: options.edit,
          ...(options.statusOptions ?? {}),
        } as any);
        return { success: true, key: (result as any)?.key };
      } catch (err) {
        PreviewLogger.sendFailed(jid, 'poll', String(err));
        return { success: false };
      }
    }

    // ── Pipeline Stage: Media Send ──────────────────────────
    if (options.media) {
      try {
        let content: any;
        const { type, buffer, mimetype, fileName, caption, ptt, gifPlayback } = options.media;
        
        if (type === 'image') content = { image: buffer, caption: caption ?? text };
        else if (type === 'video') content = { video: buffer, caption: caption ?? text, gifPlayback };
        else if (type === 'audio') content = { audio: buffer, mimetype: mimetype ?? 'audio/mp4', ptt };
        else if (type === 'sticker') content = { sticker: buffer };
        else if (type === 'document') content = { document: buffer, mimetype: mimetype ?? 'application/octet-stream', fileName, caption: caption ?? text };
        else content = { text, ...(options.extra ?? {}) };

        if (options.extra) content = { ...content, ...options.extra };
        if (options.externalAdReply) {
          content.contextInfo = { ...content.contextInfo, externalAdReply: options.externalAdReply };
        }

        content = applyGlobalPipeline(content);
        const result = await socket.sendMessage(jid, content as AnyMessageContent, {
          quoted: options.quoted,
          edit: options.edit,
          ...(options.statusOptions ?? {}),
        } as any);
        return { success: true, key: (result as any)?.key };
      } catch (err) {
        PreviewLogger.sendFailed(jid, 'media', String(err));
        return { success: false };
      }
    }

    // Step 1: Detect URL (only if not media/poll)
    const url = options.existingPreview?.url ?? UrlDetector.extractFirst(text || '');

    if (!url || options.suppressPreview) {
      // No URL or suppressed — send plain text
      try {
        let content: any = {
          text,
          ...(options.extra ?? {}),
        };
        if (options.externalAdReply) {
          content.contextInfo = { ...content.contextInfo, externalAdReply: options.externalAdReply };
        }
        
        content = applyGlobalPipeline(content);
        
        const result = await socket.sendMessage(jid, content as AnyMessageContent, {
          quoted: options.quoted,
          edit: options.edit,
          ...(options.statusOptions ?? {}),
        } as any);
        PreviewLogger.sent(jid, url ?? 'no-url');
        return { success: true, key: (result as any)?.key };
      } catch (err) {
        PreviewLogger.sendFailed(jid, url ?? 'no-url', String(err));
        return { success: false };
      }
    }

    // Step 2: Check if WhatsApp group link
    const isGroupLink = PreviewValidator.isGroupInviteLink(url);

    // Step 3: Resolve preview
    let payload: PreviewPayload;
    try {
      payload = await resolveLimit(async () => {
        const socketLike = isGroupLink
          ? socket
          : undefined;

        let resolvedPreview: PartialLinkMeta | undefined;

        // For group links: resolve via socket if no existingPreview
        if (isGroupLink && !options.existingPreview?.thumbnail) {
          resolvedPreview = await PreviewResolver.resolveGroup(url, socket);
        }

        // Resolve full preview
        const result = await PreviewResolver.resolve(
          url,
          {
            suppressPreview: options.suppressPreview,
            existingPreview: options.existingPreview ?? resolvedPreview,
            forceStage: options.forceStage,
            socket: socketLike,
          }
        );

        // Build payload
        return PayloadBuilder.build(text, {
          suppressPreview: options.suppressPreview,
          meta: result.meta,
          hqThumbnail: result.meta.hqThumbnail,
          extra: options.extra,
          isGroupStatus: options.isGroupStatus,
          previewType: options.previewType,
        });
      });
    } catch (err) {
      // Self-healing: fallback to plain text
      PreviewLogger.fallbackActivated('send', 'resolve', 'plain-text');
      PreviewLogger.sendFailed(jid, url, String(err));
      try {
        let content: any = { text };
        content = applyGlobalPipeline(content);
        await socket.sendMessage(jid, content as AnyMessageContent, options.statusOptions as any);
        return { success: true, stage: 'Stage5_UrlOnly' };
      } catch {
        return { success: false };
      }
    }

    // Step 4: Send
    try {
      PreviewLogger.sending(jid, url, payload.previewStage);

      let key: any;
      if (options.isGroupStatus) {
        // Group status uses relayMessage
        const genId = await PreviewDispatcher.getGenerateMessageIDV2();
        const msgId = genId(socket.user?.id ?? '');
        const msg = payload.content as unknown as Record<string, unknown>;
        await socket.relayMessage(jid, msg, { messageId: msgId });
        key = { remoteJid: jid, fromMe: true, id: msgId };
      } else {
        // Normal chat send
        let finalContent = options.externalAdReply
          ? PayloadBuilder.withExternalAdReply(payload, options.externalAdReply).content
          : payload.content;
        
        finalContent = applyGlobalPipeline(finalContent);
        
        const result = await socket.sendMessage(jid, finalContent, {
          quoted: options.quoted,
          edit: options.edit,
          ...(options.statusOptions ?? {}),
        } as any);
        key = (result as any)?.key;
      }

      PreviewLogger.sent(jid, url);
      return { success: true, stage: payload.previewStage, key };
    } catch (err) {
      PreviewLogger.sendFailed(jid, url, String(err));
      // Self-healing: try without preview
      try {
        let content: any = { text };
        content = applyGlobalPipeline(content);
        await socket.sendMessage(jid, content as AnyMessageContent, options.statusOptions as any);
        return { success: true, stage: 'Stage5_UrlOnly' };
      } catch {
        return { success: false };
      }
    }
  }

  // ── Broadcast Send ────────────────────────────────────────

  /**
   * Send the same message to multiple JIDs with proper payload cloning.
   * Each recipient gets a fresh immutable copy.
   */
  static async broadcast(
    socket: DispatcherSocket,
    jids: string[],
    text: string,
    options: DispatchOptions = {}
  ): Promise<{ success: number; failed: number }> {
    // Resolve preview ONCE for the entire broadcast
    const url = options.existingPreview?.url ?? UrlDetector.extractFirst(text);
    let resolvedMeta: PartialLinkMeta | undefined;

    if (url && !options.suppressPreview) {
      try {
        const result = await PreviewResolver.resolve(url, {
          existingPreview: options.existingPreview,
        });
        resolvedMeta = result.meta;
      } catch {
        // Fallback: no preview for broadcast
        resolvedMeta = undefined;
      }
    }

    const payload = PayloadBuilder.build(text, {
      suppressPreview: options.suppressPreview,
      meta: resolvedMeta,
      isGroupStatus: options.isGroupStatus,
      previewType: options.previewType,
    });

    let success = 0;
    let failed = 0;

    for (const jid of jids) {
      try {
        // Clone payload for each recipient (immutable)
        const recipientPayload = PayloadBuilder.cloneForBroadcast(payload);

        if (options.isGroupStatus) {
          const genId = await PreviewDispatcher.getGenerateMessageIDV2();
          const msgId = genId(socket.user?.id ?? '');
          const msg = recipientPayload.content as unknown as Record<string, unknown>;
          await socket.relayMessage(jid, msg, { messageId: msgId });
        } else {
          await socket.sendMessage(jid, recipientPayload.content);
        }
        success++;
      } catch {
        failed++;
      }
    }

    return { success, failed };
  }

  // ── Cache Management ──────────────────────────────────────

  static invalidateCache(url?: string): void {
    previewCache.invalidate(url);
  }

  static getCacheStats() {
    return previewCache.getStats();
  }
}

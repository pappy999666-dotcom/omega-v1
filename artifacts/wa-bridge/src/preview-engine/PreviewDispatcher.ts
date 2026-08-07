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
import {
  sanitizeMentionJids,
  syncMentionTokens,
  MENTION_TOKEN_RE,
} from '../whatsapp/utils/mention-engine.js';
import {
  nativeTableContent,
  type NativeTableContent,
} from '../whatsapp/utils/native-rich.js';

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
  /** Native rich-response table (richResponseMessage GenATableUXPrimitive). */
  nativeTable?: NativeTableContent;
  /** Plain-text fallback used when the native table send fails. */
  tableFallbackText?: string;
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

    // ── Status JID List (status@broadcast) ──
    // The fork's sendMessage status branch REQUIRES a non-empty statusJidList
    // (normalizeStatusJidList throws "statusJidList must contain at least one
    // recipient JID" otherwise). Resolve it centrally so every status post
    // (pstatus, godcast, statusdesign, smedia, gstatus, spam, omni status)
    // always carries a valid recipient list — even on fresh sessions with no
    // contacts synced (self-JID fallback).
    if (jid === 'status@broadcast') {
      const { resolveStatusJidList } = await import('../whatsapp/utils/status-jids.js');
      const list = resolveStatusJidList(socket, options.sessionId);
      options.statusOptions = { ...(options.statusOptions ?? {}), statusJidList: list };
    }

    // ── Pipeline Stage: Session Config & Policy ──
    // Central Mention Engine: normalize every mention JID to a REAL phone JID
    // (@s.whatsapp.net). LID entries are resolved through the fork's lidMapping
    // + participant list; unresolvable entries are dropped. This guarantees the
    // mentionedJid array always matches the @<phone> tokens in the text — the
    // structural precondition for native WhatsApp mentions. When nothing can be
    // resolved the original array is kept so silent hidetag pings still work.
    const hadMentionOption =
      Array.isArray(options.extra?.mentions) &&
      (options.extra!.mentions as unknown[]).length > 0;
    let mentions: string[] = hadMentionOption
      ? [...(options.extra!.mentions as string[])]
      : [];
    let sendText = text ?? '';

    if (mentions.length > 0) {
      try {
        const sanitized = await sanitizeMentionJids(socket as never, mentions);
        if (sanitized.length > 0) mentions = sanitized;
      } catch {
        // keep originals — never fail a send over mention normalization
      }
    }

    // ── Structural mention invariant (global) ──
    // Every @<digits> token in the outgoing text must have its phone JID in
    // the mentionedJid array, or WhatsApp renders the raw number. Sync any
    // token that is not already covered so hand-written tokens (moderation
    // cards, .tag @mention echoes, quoted relaying) always render natively.
    if (mentions.length > 0 || MENTION_TOKEN_RE.test(sendText)) {
      try {
        const synced = await syncMentionTokens(socket as never, sendText, mentions);
        sendText = synced.text;
        mentions = synced.mentions;
      } catch {
        // keep originals — never fail a send over token sync
      }
    }

    // tagReply=false disables tagging in replies: strip BOTH the mention array
    // AND any @<digits> tokens so no raw phone number leaks into the text while
    // the array is gone (rendered text must stay in sync with mentionedJid).
    if (
      options.sessionId &&
      options.telegramId &&
      !options.forceMentions &&
      hadMentionOption
    ) {
      const config = loadSessionConfig(options.telegramId, options.sessionId);
      if (config.tagReply === false) {
        mentions = [];
        sendText = sendText
          .replace(MENTION_TOKEN_RE, '')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
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
        // Remove the top-level `buttons` key that was spread from options.extra into
        // the initial content object.  Leaving it alongside nativeFlow confuses Baileys
        // into treating the message as a buttonsMessage instead of a nativeFlowMessage,
        // which prevents the cta_copy / cta_url buttons from functioning.
        delete finalContent.buttons;
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

    // ── Pipeline Stage: Native Table (richResponseMessage) ────
    // The fork's GenATableUXPrimitive inside botForwardedMessage.
    if (options.nativeTable) {
      try {
        let content: any = nativeTableContent(options.nativeTable);
        if (options.extra) content = { ...content, ...options.extra };
        content = applyGlobalPipeline(content);
        const result = await socket.sendMessage(jid, content as AnyMessageContent, {
          quoted: options.quoted,
          edit: options.edit,
          ...(options.statusOptions ?? {}),
        } as any);
        return { success: true, key: (result as any)?.key };
      } catch (err) {
        PreviewLogger.sendFailed(jid, 'table', String(err));
        // Self-healing: fall back to the provided plain-text card so the
        // response is never lost (e.g. a client rejects the GenAI payload).
        if (options.tableFallbackText) {
          try {
            let fallbackContent: any = { text: options.tableFallbackText };
            fallbackContent = applyGlobalPipeline(fallbackContent);
            await socket.sendMessage(jid, fallbackContent as AnyMessageContent, {
              quoted: options.quoted,
              ...(options.statusOptions ?? {}),
            } as any);
            return { success: true, stage: 'Stage5_UrlOnly' };
          } catch {
            // fall through to failure
          }
        }
        return { success: false };
      }
    }

    // ── Pipeline Stage: Media Send ──────────────────────────
    if (options.media) {
      try {
        let content: any;
        const { type, buffer, mimetype, fileName, caption, ptt, gifPlayback } = options.media;
        
        if (type === 'image') content = { image: buffer, caption: caption ?? sendText };
        else if (type === 'video') content = { video: buffer, caption: caption ?? sendText, gifPlayback };
        else if (type === 'audio') content = { audio: buffer, mimetype: mimetype ?? 'audio/mp4', ptt };
        else if (type === 'sticker') content = { sticker: buffer, mimetype: mimetype ?? 'image/webp' };
        else if (type === 'document') content = { document: buffer, mimetype: mimetype ?? 'application/octet-stream', fileName, caption: caption ?? sendText };
        else content = { text: sendText, ...(options.extra ?? {}) };

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
    const url = options.existingPreview?.url ?? UrlDetector.extractFirst(sendText || '');

    if (!url || options.suppressPreview) {
      // No URL or suppressed — send plain text
      try {
        let content: any = {
          text: sendText,
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
        return PayloadBuilder.build(sendText, {
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
        let content: any = { text: sendText };
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
        let content: any = { text: sendText };
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

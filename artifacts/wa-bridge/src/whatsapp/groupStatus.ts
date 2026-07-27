// ============================================================
// WA-Bridge — Group Status Sending
//
// PATH 0  AS_IS   — source has WA-built extendedTextMessage → likeThis relay
// PATH B  RICH    — URL found, no WA preview → richPreview:true (Baileys fetches)
// PATH C  PLAIN   — no URL → plain text groupStatus
// ============================================================

import type { BridgeWASocket as WASocket, IMessage } from './baileys-types.js';
import { UrlDetector } from '../preview-engine/index.js';
import type { PartialLinkMeta } from '../preview-engine/types.js';
import { PreviewHydrator } from '../preview-engine/PreviewHydrator.js';
import { resolvePreviewRoute } from './preview-router.js';
import { sendStatusAsIs } from './status-as-is.js';
import { logger } from '../utils/logger.js';

// Import from exact Baileys internal paths — not exported from main index
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const baileysPaths = {
  buildLinkPreview: null as any,
  prepareWAMessageMedia: null as any,
  generateMessageIDV2: null as any,
};
async function getBaileys() {
  if (!baileysPaths.buildLinkPreview) {
    const [media, msgs, gen] = await Promise.all([
      import('@crysnovax/baileys/lib/Utils/messages-media.js' as never) as Promise<Record<string, unknown>>,
      import('@crysnovax/baileys/lib/Utils/messages.js' as never) as Promise<Record<string, unknown>>,
      import('@crysnovax/baileys/lib/Utils/generics.js' as never) as Promise<Record<string, unknown>>,
    ]);
    baileysPaths.buildLinkPreview = media['buildLinkPreview'];
    baileysPaths.prepareWAMessageMedia = msgs['prepareWAMessageMedia'];
    baileysPaths.generateMessageIDV2 = gen['generateMessageIDV2'];
  }
  return baileysPaths;
}

export interface GroupStatusOptions {
  mediaBuffer?: Buffer;
  mediaType?: 'image' | 'video' | 'audio';
  caption?: string;
  likeThis?: boolean;
  existingPreview?: PartialLinkMeta;
  /** Raw source message for as-is relay (PATH 0) */
  sourceMsg?: { message?: IMessage | null };
}

type Sock = {
  user: { id: string };
  relayMessage: (jid: string, message: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>;
  sendMessage: (jid: string, content: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ key?: { id?: string } } | undefined>;
  waUploadToServer: (stream: unknown, opts: unknown) => Promise<unknown>;
  groupGetInviteInfo?: (code: string) => Promise<{ id: string; subject?: string; size?: number }>;
  profilePictureUrl?: (jid: string, type: string) => Promise<string | null>;
};

// ── Build preview using Baileys-native pipeline ───────────────
// Follows crysnovax/CODY reference implementation exactly:
// buildLinkPreview → prepareWAMessageMedia with waUploadToServer → HQ directPath + mediaKey
async function buildStatusPreview(
  url: string,
  sock: Sock
): Promise<{
  url: string;
  title: string;
  description: string;
  smallThumb: Buffer | null;
  hq: Record<string, unknown> | null;
} | null> {
  try {
    const { buildLinkPreview, prepareWAMessageMedia } = await getBaileys();
    const result = await buildLinkPreview(url, sock, { customTitle: '', customDesc: '' });
    if (!result) return null;

    let hq: Record<string, unknown> | null = null;
    let smallThumb: Buffer | null = null;

    if (result.imageBuffer) {
      try {
        const prepared = await prepareWAMessageMedia(
          { image: result.imageBuffer },
          { upload: sock.waUploadToServer, mediaTypeOverride: 'thumbnail-link' }
        );
        hq = prepared?.imageMessage ?? null;
        smallThumb = hq?.jpegThumbnail ? Buffer.from(hq.jpegThumbnail as Uint8Array) : null;
      } catch (err) {
        logger.warn('[GroupStatus] HQ thumb upload failed', { err: String(err) });
      }
    }

    return {
      url,
      title: result.title || '',
      description: result.description || '',
      smallThumb,
      hq,
    };
  } catch (err) {
    logger.warn('[GroupStatus] buildStatusPreview failed', { url, err: String(err) });
    return null;
  }
}

export async function sendGroupStatus(
  socket: WASocket,
  sessionId: string,
  groupJid: string,
  text: string,
  options: GroupStatusOptions = {}
): Promise<void> {
  try {
    if (!groupJid.endsWith('@g.us')) throw new Error('A valid group JID is required');
    const sock = socket as unknown as Sock;

    // ── Media path ────────────────────────────────────────────
    if (options.mediaBuffer) {
      await sock.sendMessage(groupJid, {
        ...(options.mediaType === 'video'
          ? { video: options.mediaBuffer, caption: options.caption ?? text, gifPlayback: false }
          : options.mediaType === 'audio'
          ? { audio: options.mediaBuffer, mimetype: 'audio/mp4', ptt: false }
          : { image: options.mediaBuffer, caption: options.caption ?? text }),
        groupStatus: true,
        ...(options.likeThis ? { likeThis: true } : {}),
      });
      logger.info('[GroupStatus] Media sent', { sessionId, groupJid });
      return;
    }

    // ── Text path — route via preview-router ─────────────────
    const route = options.sourceMsg
      ? resolvePreviewRoute(options.sourceMsg, text)
      : { route: 'RICH' as const, url: options.existingPreview?.url ?? UrlDetector.extractFirst(text) ?? undefined };

    // ── PATH 0: AS_IS — relay WA-built extendedTextMessage verbatim ──
    if (route.route === 'AS_IS' && route.sourceExt) {
      const sent = await sendStatusAsIs(socket, groupJid, text, route.sourceExt);
      if (sent) {
        logger.info('[GroupStatus] PATH 0 AS_IS sent', { sessionId, groupJid });
        return;
      }
      // fallthrough to RICH if likeThis failed
    }

    const url = route.url ?? options.existingPreview?.url ?? UrlDetector.extractFirst(text);

    // ── PATH C: PLAIN — no URL ────────────────────────────────
    if (!url) {
      const msg = PreviewHydrator.buildGroupStatusMessage(text, undefined, undefined);
      const { generateMessageIDV2 } = await getBaileys();
      const msgId = generateMessageIDV2(sock.user.id);
      await sock.relayMessage(groupJid, msg as unknown as Record<string, unknown>, { messageId: msgId });
      logger.info('[GroupStatus] PATH C plain text sent', { sessionId, groupJid });
      return;
    }

    // ── PATH B: RICH — build HQ preview ──────────────────────
    let preview: { url: string; title: string; description: string; smallThumb: Buffer | null; hq: Record<string, unknown> | null } | null = null;

    if (options.existingPreview?.thumbnail) {
      const buf = Buffer.from(options.existingPreview.thumbnail);
      try {
        const { prepareWAMessageMedia } = await getBaileys();
        const prepared = await prepareWAMessageMedia(
          { image: buf },
          { upload: sock.waUploadToServer, mediaTypeOverride: 'thumbnail-link' }
        );
        const hq = prepared?.imageMessage ? { ...prepared.imageMessage } : null;
        if (hq?.jpegThumbnail) hq.jpegThumbnail = Buffer.from(hq.jpegThumbnail as Uint8Array);
        preview = {
          url,
          title: options.existingPreview.title || '',
          description: options.existingPreview.description || '',
          smallThumb: hq?.jpegThumbnail ? Buffer.from(hq.jpegThumbnail as Uint8Array) : buf,
          hq,
        };
      } catch (err) {
        logger.warn('[GroupStatus] HQ upload failed during passthrough', { err: String(err) });
        preview = { url, title: options.existingPreview.title || '', description: options.existingPreview.description || '', smallThumb: buf, hq: null };
      }
    } else {
      preview = await buildStatusPreview(url, sock);
    }

    const msg = PreviewHydrator.buildGroupStatusMessage(text, {
      url: preview?.url ?? url,
      title: preview?.title ?? '',
      description: preview?.description ?? '',
      thumbnail: preview?.smallThumb ? Buffer.from(preview.smallThumb) : undefined,
    }, preview?.hq ?? undefined);

    const { generateMessageIDV2 } = await getBaileys();
    const msgId = generateMessageIDV2(sock.user.id);
    await sock.relayMessage(groupJid, msg as unknown as Record<string, unknown>, { messageId: msgId });
    logger.info('[GroupStatus] PATH B RICH sent', { sessionId, groupJid, hasHQ: !!preview?.hq });
  } catch (error) {
    logger.error('[GroupStatus] Failed', { sessionId, groupJid, error: String(error) });
    throw error;
  }
}

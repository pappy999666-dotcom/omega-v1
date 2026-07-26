// ============================================================
// WA-Bridge — Group Status Sending
// Posts to group status with full HQ preview.
//
// Uses the centralized PreviewManager for metadata resolution
// and Baileys-native pipeline for HQ thumbnail upload.
// ============================================================

import type { BridgeWASocket as WASocket } from './baileys-types.js';
// ── SINGLE IMPORT: All preview operations via PreviewManager ──
import { PreviewManager, UrlDetector } from '../preview-engine/index.js';
import type { PartialLinkMeta } from '../preview-engine/types.js';
import { PreviewHydrator } from '../preview-engine/PreviewHydrator.js';
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

    // ── Text path ─────────────────────────────────────────────
    // Extract URL using centralized UrlDetector
    const url = options.existingPreview?.url ?? UrlDetector.extractFirst(text);

    if (!url) {
      // No URL — plain text status
      const msg = PreviewHydrator.buildGroupStatusMessage(text, undefined, undefined);
      const { generateMessageIDV2 } = await getBaileys();
      const msgId = generateMessageIDV2(sock.user.id);
      await sock.relayMessage(groupJid, msg as unknown as Record<string, unknown>, { messageId: msgId });
      logger.info('[GroupStatus] Plain text sent', { sessionId, groupJid });
      return;
    }

    // Build preview once — if existingPreview has thumbnail already use it,
    // otherwise fetch fresh via buildLinkPreview + waUploadToServer
    let preview: { url: string; title: string; description: string; smallThumb: Buffer | null; hq: Record<string, unknown> | null } | null = null;

    if (options.existingPreview?.thumbnail) {
      // Stage 1 passthrough — but still upload to WA servers for HQ
      const buf = Buffer.from(options.existingPreview.thumbnail);
      try {
        const { prepareWAMessageMedia } = await getBaileys();
        const prepared = await prepareWAMessageMedia(
          { image: buf },
          { upload: sock.waUploadToServer, mediaTypeOverride: 'thumbnail-link' }
        );
        const hq = prepared?.imageMessage ?? null;
        preview = {
          url,
          title: options.existingPreview.title || '',
          description: options.existingPreview.description || '',
          smallThumb: hq?.jpegThumbnail ? Buffer.from(hq.jpegThumbnail as Uint8Array) : buf,
          hq,
        };
      } catch {
        preview = {
          url,
          title: options.existingPreview.title || '',
          description: options.existingPreview.description || '',
          smallThumb: buf,
          hq: null,
        };
      }
    } else {
      // Stage 2 — fresh fetch via Baileys-native buildLinkPreview
      preview = await buildStatusPreview(url, sock);
    }

    const msg = PreviewHydrator.buildGroupStatusMessage(text, {
      url: preview?.url ?? url,
      title: preview?.title ?? '',
      description: preview?.description ?? '',
      thumbnail: preview?.smallThumb ? new Uint8Array(preview.smallThumb) : undefined,
    }, preview?.hq ?? undefined);

    const { generateMessageIDV2 } = await getBaileys();
    const msgId = generateMessageIDV2(sock.user.id);
    await sock.relayMessage(groupJid, msg as unknown as Record<string, unknown>, { messageId: msgId });

    logger.info('[GroupStatus] Sent', { sessionId, groupJid, hasPreview: !!preview, hasHQ: !!preview?.hq });
  } catch (error) {
    logger.error('[GroupStatus] Failed', { sessionId, groupJid, error: String(error) });
    throw error;
  }
}

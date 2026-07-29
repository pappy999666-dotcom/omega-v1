// ============================================================
// Anti System — AntiMedia Modules (AntiPic, AntiVid, AntiAud)
// Separate detectors for image, video, and audio messages.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

function unwrap(msg: WebMessageInfo): AnyMsg | null {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return null;
  // Unwrap view-once / ephemeral containers
  return (
    ((m['viewOnceMessage'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    ((m['viewOnceMessageV2'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    ((m['viewOnceMessageV2Extension'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    ((m['ephemeralMessage'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    ((m['documentWithCaptionMessage'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    m
  );
}

export function messageIsImage(msg: WebMessageInfo): boolean {
  const m = unwrap(msg);
  return Boolean(m?.['imageMessage']);
}

export function messageIsVideo(msg: WebMessageInfo): boolean {
  const m = unwrap(msg);
  if (!m) return false;
  const vid = m['videoMessage'] as AnyMsg | undefined;
  if (!vid) return false;
  const mime = String(vid['mimetype'] ?? '');
  return mime.startsWith('video/') || mime === '';
}

export function messageIsAudio(msg: WebMessageInfo): boolean {
  const m = unwrap(msg);
  if (!m) return false;
  const audio = m['audioMessage'] as AnyMsg | undefined;
  if (!audio) return false;
  return !audio['ptt']; // ptt = push-to-talk = voice note
}

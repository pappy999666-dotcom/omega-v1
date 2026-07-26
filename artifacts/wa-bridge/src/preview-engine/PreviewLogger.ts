// ============================================================
// Preview Engine — Logger
// Every preview request is traceable
// ============================================================

import { logger } from '../utils/logger.js';
import type { FailureClass, PreviewStage, PreviewTrace } from './types.js';

let traceCounter = 0;

export class PreviewLogger {
  // ── URL Detection ─────────────────────────────────────────

  static urlDetected(url: string, source: string): void {
    logger.debug('[PreviewEngine:Detect] URL found', { url, source });
  }

  static noUrlDetected(source: string): void {
    logger.debug('[PreviewEngine:Detect] No URL found', { source });
  }

  // ── Cache ─────────────────────────────────────────────────

  static cacheHit(url: string, type: 'meta' | 'thumbnail' | 'hq'): void {
    logger.debug('[PreviewEngine:Cache] Hit', { url, type });
  }

  static cacheMiss(url: string, type: 'meta' | 'thumbnail' | 'hq'): void {
    logger.debug('[PreviewEngine:Cache] Miss', { url, type });
  }

  static cacheSet(url: string, type: 'meta' | 'thumbnail' | 'hq'): void {
    logger.debug('[PreviewEngine:Cache] Set', { url, type });
  }

  static cacheInvalidated(url?: string): void {
    logger.info('[PreviewEngine:Cache] Invalidated', { url: url ?? 'ALL' });
  }

  // ── Metadata Fetch ────────────────────────────────────────

  static fetchingMetadata(url: string, stage: PreviewStage): void {
    logger.debug('[PreviewEngine:Metadata] Fetching', { url, stage });
  }

  static metadataFetched(url: string, hasTitle: boolean, hasDescription: boolean): void {
    logger.debug('[PreviewEngine:Metadata] Fetched', { url, hasTitle, hasDescription });
  }

  static metadataFailed(url: string, failureClass: FailureClass, error: string): void {
    logger.warn('[PreviewEngine:Metadata] Failed', { url, failureClass, error });
  }

  static metadataFallback(url: string, from: PreviewStage, to: PreviewStage): void {
    logger.debug('[PreviewEngine:Metadata] Fallback', { url, from, to });
  }

  // ── Thumbnail ─────────────────────────────────────────────

  static fetchingThumbnail(url: string): void {
    logger.debug('[PreviewEngine:Thumbnail] Fetching', { url });
  }

  static thumbnailFetched(url: string, size: number): void {
    logger.debug('[PreviewEngine:Thumbnail] Fetched', { url, size });
  }

  static thumbnailFailed(url: string, failureClass: FailureClass): void {
    logger.debug('[PreviewEngine:Thumbnail] Failed', { url, failureClass });
  }

  static thumbnailNormalized(url: string, beforeBytes: number, afterBytes: number): void {
    logger.debug('[PreviewEngine:Thumbnail] Normalized', { url, beforeBytes, afterBytes });
  }

  // ── HQ Thumbnail Upload ───────────────────────────────────

  static uploadingHQThumbnail(url: string): void {
    logger.debug('[PreviewEngine:HQ] Uploading', { url });
  }

  static hqUploaded(url: string): void {
    logger.debug('[PreviewEngine:HQ] Uploaded', { url });
  }

  static hqUploadFailed(url: string, error: string): void {
    logger.warn('[PreviewEngine:HQ] Upload failed', { url, error });
  }

  // ── Hydration ─────────────────────────────────────────────

  static hydrating(stage: PreviewStage, url: string): void {
    logger.debug('[PreviewEngine:Hydrate] Building payload', { stage, url });
  }

  static hydrated(stage: PreviewStage, url: string): void {
    logger.debug('[PreviewEngine:Hydrate] Complete', { stage, url });
  }

  // ── Payload ───────────────────────────────────────────────

  static payloadBuilt(stage: PreviewStage, url: string): void {
    logger.debug('[PreviewEngine:Payload] Built', { stage, url });
  }

  // ── Send ──────────────────────────────────────────────────

  static sending(jid: string, url: string, stage: PreviewStage): void {
    logger.debug('[PreviewEngine:Send] Sending', { jid, url, stage });
  }

  static sent(jid: string, url: string): void {
    logger.debug('[PreviewEngine:Send] ACK', { jid, url });
  }

  static sendFailed(jid: string, url: string, error: string): void {
    logger.warn('[PreviewEngine:Send] Failed', { jid, url, error });
  }

  // ── Self-Healing ──────────────────────────────────────────

  static retryAttempt(label: string, attempt: number, max: number): void {
    logger.debug('[PreviewEngine:Retry] Attempt', { label, attempt, max });
  }

  static retryExhausted(label: string, failureClass: FailureClass): void {
    logger.warn('[PreviewEngine:Retry] Exhausted', { label, failureClass });
  }

  static fallbackActivated(label: string, from: string, to: string): void {
    logger.info('[PreviewEngine:Fallback] Activated', { label, from, to });
  }

  // ── Trace ─────────────────────────────────────────────────

  static createTraceId(): string {
    return `prev-${Date.now().toString(36)}-${(++traceCounter).toString(36)}`;
  }

  static completeTrace(trace: PreviewTrace): void {
    logger.info('[PreviewEngine:Trace] Complete', trace);
  }
}

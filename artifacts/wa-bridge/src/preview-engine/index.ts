// ============================================================
// Preview Engine — Barrel Export
// Import everything from this single entry point.
// ============================================================

// Core Manager
export { PreviewManager } from './PreviewManager.js';
export type { DispatchOptions } from './PreviewDispatcher.js';

// Modules
export { UrlDetector } from './UrlDetector.js';
export { PreviewResolver } from './PreviewResolver.js';
export { MetadataResolver } from './MetadataResolver.js';
export { ThumbnailResolver } from './ThumbnailResolver.js';
export { PreviewHydrator } from './PreviewHydrator.js';
export { PreviewValidator } from './PreviewValidator.js';
export { PayloadBuilder } from './PayloadBuilder.js';
export { PreviewDispatcher } from './PreviewDispatcher.js';
export { PreviewLogger } from './PreviewLogger.js';
export { PreviewCache, previewCache } from './PreviewCache.js';

// Types
export type {
  LinkMeta,
  PartialLinkMeta,
  PreviewStage,
  FailureClass,
  PreviewOptions,
  PreviewTrace,
  CacheEntry,
  SocketLike,
  MessageSource,
  PreviewPayload,
  BaileysLinkPreview,
  GroupStatusMessage,
} from './types.js';

// ============================================================
// WA-Bridge — preview-generator (compatibility shim)
// All logic lives in preview-manager.ts
// ============================================================

export {
  extractFirstUrl,
  extractUrls,
  fetchLinkMeta,
  hydratedMessage,
  cloneForBroadcast,
  invalidatePreviewCache,
  getPreviewCacheStats,
} from './preview-manager.js';

export type { LinkMeta, PreviewFailureClass } from './preview-manager.js';

// ============================================================
// Anti System — Response Template Renderer
// Now delegates to the shared response-engine.
// Kept as a thin re-export for backward compatibility.
// ============================================================

export type { ResponseContext } from '../../utils/response-engine.js';
export { renderTemplate as renderResponse } from '../../utils/response-engine.js';

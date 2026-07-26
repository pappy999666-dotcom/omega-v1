# OMEGA WA-Bridge Preview Architecture Audit

## Current File Map

### Preview-Related Files
| File | Role | Status |
|------|------|--------|
| `src/whatsapp/preview-generator.ts` | Core: fetchLinkMeta, hydratedMessage, toBaileysLinkPreview, resolveGroupPreview | DUPLICATE of preview-manager |
| `src/whatsapp/preview-manager.ts` | Core v2: fetchLinkMeta (multi-stage), hydratedMessage, cloneForBroadcast, cache | DUPLICATE of preview-generator |
| `src/whatsapp/chat-preview.ts` | Chat path helper: buildChatPreview, resolvePreviewOnce | Thin wrapper around preview-generator |

### Command Files (all send through preview helpers)
| File | Preview Usage |
|------|---------------|
| `src/whatsapp/event-handlers.ts` | `hydratedMessage`, `extractIncomingPreview`, `extractFirstUrl` in baseWhatsAppReply + quotedPreview passthrough |
| `src/whatsapp/commands/status.ts` | `hydratedMessageWithSocket`, `buildChatPreview` |
| `src/whatsapp/commands/tag.ts` | `buildChatPreview` with existingPreview |
| `src/whatsapp/commands/mass-outreach.ts` | `resolvePreviewOnce`, `sendGroupStatus` (allstatus), `buildChatPreview` (allchat) |
| `src/whatsapp/commands/lifecycle.ts` | `hydratedMessage` for autoPromote |

### Specialized Send Paths
| File | Preview Usage |
|------|---------------|
| `src/whatsapp/groupStatus.ts` | Baileys-internal buildLinkPreview, prepareWAMessageMedia, generateMessageIDV2 — DIRECT Baileys internals |
| `src/services/workers/omni-worker.ts` | `{ text }` only — NO preview at all (bypass) |

## Key Observations

### Duplicated Preview Logic
1. `preview-generator.ts` and `preview-manager.ts` BOTH export `fetchLinkMeta`, `hydratedMessage`, `extractFirstUrl`
2. `chat-preview.ts` wraps `preview-generator.ts`
3. Commands import from different modules inconsistently

### Event Handlers Import Pattern
- `event-handlers.ts` imports from `preview-generator.ts`
- `status.ts` imports from BOTH `preview-generator.ts` and `chat-preview.ts`
- `tag.ts` imports from `chat-preview.ts`
- `mass-outreach.ts` imports from `chat-preview.ts` AND uses `sendGroupStatus` directly
- `lifecycle.ts` imports from `preview-generator.ts`

### Two Distinct Preview Engines
1. **Link-preview-js engine** (preview-manager.ts): multi-stage fetch with cheerio fallback
2. **Baileys-native engine** (preview-generator.ts): getLinkPreview + normalizeThumbnail with sharp

### Group Status Pipeline
- Uses Baileys internal APIs: `buildLinkPreview`, `prepareWAMessageMedia`, `generateMessageIDV2`
- Builds raw `groupStatusMessageV2` payloads manually
- Has its own Stage 1 passthrough and Stage 2 fresh build logic
- Completely separate from the chat pipeline

### Omni Worker Bypass
- `omni-worker.ts` sends `{ text }` directly — no preview pipeline at all
- Used for admin broadcast commands across all sessions

### External Ad Reply (Menu Card)
- Built directly in `event-handlers.ts` baseWhatsAppReply
- Uses `contextInfo.externalAdReply` with thumbnailUrl
- Cached per-session in `menuAdReplyCache`
- Separate from the preview system

### Socket Configuration
- `generateHighQualityLinkPreview: true` is set in socket-manager
- Baileys auto-fetches previews for normal sendMessage calls

## Migration Targets (all must route through Preview Manager)
1. event-handlers.ts: baseWhatsAppReply
2. event-handlers.ts: quotedPreview passthrough to gstatus/allstatus/togstatus/tag/mtag
3. status.ts: cmdGStatus (hydratedMessageWithSocket), cmdToChat (buildChatPreview), cmdToChatX (buildChatPreview), cmdSStatus (hydratedMessageWithSocket)
4. tag.ts: cmdTag (buildChatPreview), cmdMTag (buildChatPreview)
5. mass-outreach.ts: cmdAllStatus (resolvePreviewOnce + sendGroupStatus), cmdAllChat (buildChatPreview)
6. groupStatus.ts: sendGroupStatus (Baileys internals)
7. lifecycle.ts: maybeAutoPromote (hydratedMessage)
8. omni-worker.ts: broadcast/status (raw { text })

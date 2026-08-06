# Implementation Status

## Changes Implemented So Far

### 1. Public Mode Default ON ✅
- Changed `publicMode: false` → `publicMode: true` in workspace.ts defaultConfig

### 2. Tag Reply Default ON ✅
- Already was `tagReply: true` — confirmed no change needed

### 3. Remove help from Public Command List ✅
- Changed `['menu', 'help', 'gmenu', 'pair']` → `['menu', 'gmenu', 'pair']` in event-handlers.ts

### 4. Global URL Button Label Fallback ✅
- Updated `parseUrlButtons()` in url-buttons.ts to derive label from URL hostname when no label provided

### 5. Centralized Session Connected Notifications ✅
- Created `services/session-connected.ts` with `notifySessionConnected()` function
- Refactored QR pairing onConnected in telegram/handlers/session.ts
- Refactored Pairing Code onConnected in telegram/handlers/session.ts
- Refactored Reinit onConnected in telegram/handlers/session.ts
- Refactored WhatsApp pair command onConnected in event-handlers.ts

### 6. Rotating Premium Tips in Menus ✅
- Added `getPremiumTip()` and `PREMIUM_TIPS` array to ascii-art.ts
- Updated `whatsappMenu()` to include "◈ PREMIUM HIGHLIGHT" section at bottom

### 7-9. Anti System Refactor (Early Exits) ✅
- AntiGM / AntiGroupMention / AntiLink / AntiBot: added group-only early exits
- AntiNSFW: fixed early exit bug — set `triggered = true` before async check

### 10. Welcome/Goodbye via Native Events ✅
- Uses `group-participants.update` with array normalization; LID → real JID resolution
- `&pp` attaches profile picture as a SINGLE image+caption message

### 11-12. Centralized Response Pipeline (PreviewDispatcher) ✅
- Pipeline centralized via PreviewDispatcher/PreviewManager; global URL buttons + Tag Reply policy enforced

### 13. NATIVE WHATSAPP MENTIONS — CENTRAL MENTION ENGINE ✅
- `mention-engine.ts`: `resolveMention` / `sanitizeMentionJids` (LID → real phone JID)
- `syncMentionTokens()`: every `@<digits>` token in outgoing text must have its phone JID in `mentionedJid`
- PreviewDispatcher enforces the token↔JID invariant on EVERY send; `.tag`/`.mtag` union the user's
  own `contextInfo.mentionedJid` so targeted mentions always render natively

### 14. MESSAGE RENDERER & MENU SYSTEM REDESIGN ✅
- **Ping**: ONE response only (latency via ⚡ reaction round-trip, no fake loading bubble)
- **Userinfo/GetInfo**: single image+caption message (or text-only); never two messages
- **Menu** = compact navigation hub; **.help** = paginated pages (5–7 commands) with Prev/Next/Home

### 15. NATIVE BAILEYS TABLES & CENTRAL INTERACTION ROUTER ✅
Verified against the installed @crysnovax/baileys 2.7.0 fork source (generateWAMessageContent,
prepareNativeFlowButtons, rich-message-utils.js, messages-recv/send.js) with runtime smoke tests
using the fork's own serializer.

- **Native TABLE (richResponseMessage)** ✅ — `.ping` now sends the fork's `GenATableUXPrimitive`
  (`botForwardedMessage` → `richResponseMessage`, submessage type TABLE, unifiedResponse.data).
  Self-heals to the compact card if a client rejects the GenAI payload.
- **Fork capability note (listMessage)** — the fork's `sections` → `listMessage` branch is
  UNREACHABLE: any non-media payload falls into the catch-all `prepareWAMessageMedia()` and throws
  "Invalid media type". So listMessage is not serializable in this fork; the native interactive list
  is instead delivered as a **`single_select` native-flow button** (bottom sheet with rows) — the
  supported native interactive "table", verified through `prepareNativeFlowButtons`.
- **Category pages** now carry a native `single_select` command sheet (6 commands/page with usage +
  permissions; rows → `cmd:<t>:<navId>:<cmd>` help cards, `run:ping` executes ping) plus visible
  Prev/Next/Home quick_replies.
- **Central Interaction Router** (`whatsapp/interaction-router.ts`) — the single chokepoint for
  EVERY interactive reply:
  - `parseInteraction()` covers `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson`
    (single- AND double-encoded), `listResponseMessage.singleSelectReply`, `buttonsResponseMessage`,
    `templateButtonReplyMessage`, with deep unwrap of every future-proof wrapper the fork's
    `normalizeMessageContent()` knows.
  - `routeInteraction()` dispatches `menu:*` navigation, `cmd:*` help cards, `run:ping`.
- **Root cause of dead buttons fixed** — interactive replies DO arrive via `messages.upsert`
  (no receive-side filtering in the fork); the old inline parser was narrow and sat behind
  sleep-mode + anti-checks. The router now runs in `handleMessages()` BEFORE anti-checks so no
  module can swallow a navigation tap.
- New types in baileys-types.ts: `selectedDisplayText` on buttons/list responses,
  `templateButtonReplyMessage`.

## Remaining Work
1. Live-field verification on a real WhatsApp session: menu hub buttons → category sheets →
   command help cards → Prev/Next/Home; `.ping` native table rendering across Android/Web/iOS.
2. If a client fails to render the GenAI table, confirm the compact-card fallback fires (it is
   wired in PreviewDispatcher).

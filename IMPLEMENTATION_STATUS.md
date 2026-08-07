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

### 16. MODERATION ENGINE, RESPONSE MODE, MENU & GLOBAL PERMISSION REDESIGN ✅
One coherent system, not per-command patches. All validated by typecheck + runtime smoke tests.

**AntiText** — rewritten classification: deep unwrap of ephemeral/viewOnce wrappers, real
plain-text detection (no media/command false positives), command exclusion, permit list, admin
protection. No silent failures — every enforcement is logged.

**AntiWords** — complete word management system (append-only, never overwrites):
- `.setantiwords <w1, w2, …>` (multi-word, dedupe, case-insensitive, Unicode-safe, regex-safe)
- `.rmantiwords <w1, w2, …>` • `.antiwordlist` • `.clearantiwords` (confirmation required)
- Fast per-group lookup + proper persistence; module auto-enables on first add.

**Ban = local restriction (no kick)** — banned member STAYS in the group but every message type
(text, image, video, audio, voice note, document, contact, poll, sticker, location, mentions,
reactions) is deleted immediately by the anti-engine, optionally re-sends the configured ban
message (throttled), logs every attempt; `.unban` restores instantly. `cmdBan` rewritten to never
call the removal pipeline.

**AntiPromote / AntiDemote action engine** — structured actions replace the old aliases:
`restorewarn <count>` (restore victim + warn actor with kick escalation), `d/p` (demote actor +
promote victim), `d/d`, `p/p`, `p/k`; every action generates a clear response describing exactly
what happened. Same engine powers AntiPromote with reversed logic.

**Response Mode Engine (.swresponse)** — TXT ⇄ TABLE per session. `baseWhatsAppReply()` centrally
routes every card through `tableFromCard()`: usage/config/error/module-status/info cards render
as the fork's native `GenATableUXPrimitive` table; chat messages (warnings, welcomes, moderation
notices) have no row structure → stay TXT. Verified: cards convert, chat messages don't.

**Error Report Engine** — `utils/error-report.ts`: canonical `【 ❌ ERROR REPORT 】` card
(Version/Command/Message/Error/Chat/Platform + `𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭`), rendered as native table in TABLE
mode. Wired into the message-processing catch in `handleMessages()`.

**Design language** — universal `╰─ 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭` footer on every card (legacy PAPPY ×͜× removed).

**Menu dashboard** — `.menu`/`.gmenu` hub now shows status, prefix, response mode (TXT/TABLE),
timezone, date, time, user name + session status; `.help` = `.help <command>` detail cards only
(menu only navigates). `.swresponse`, `.settimezone <IANA>` (validated, per-session).

**Timezone** — `.settimezone` stored per session; threaded through welcome/goodbye templates,
menu, status; all formatting via `formatInTimezone()` (IANA, falls back to server).

**Private/Public mode** — `.setmode public|private` replaces the old toggle. Private = owners,
sudo & authorized only, others get NO response. Public = anyone. **Pair always accessible** in
both modes.

**Pair prefix-independent** — `.pair` `!pair` `/pair` `#pair` `+pair` bare `pair` (optional
leading whitespace) all work; `..pair`, `abcpair`, `nopair`, `randompair`, `pairing` rejected
(anchored regex, verified).

**Global Sudo & Omni Owner** — two platform permission layers in workspace.ts:
- Global Sudo auto-merges into EVERY session's sudo list (newly paired sessions inherit it).
- Omni Owner bypasses every permission check, inherits all Global Sudo capability.
- Both hidden from normal users: `.sudo` filters them out; management commands
  (`.globalsudo`/`.setglobalsudo`/`.delglobalsudo`, `.omni`/`.setomni`/`.delomni`) are gated to
the configuring admin.

**Baileys version check** — installed `@crysnovax/baileys` 2.7.0 vs npm latest 2.7.1 (one patch
behind). package.json pinned to `^2.7.1` so the next update-bot run picks it up.

**Smedia/media fixes** — `extractMedia()` now supports documents; audio keeps its real codec
mimetype (`audio/ogg; codecs=opus`) + ptt flag (never forced to audio/mp4); image/video/audio
document all pass their original mimetype through `sendGroupStatus`/`buildMediaContent`.

**Telegram update-bot** — ONE live console message (no duplicate "Deployment Running" bubble);
final "Update Complete" summary with the REAL file count is delivered BEFORE any restart;
PM2 reload is now non-blocking/background (no more stuck at "Pm2"); file count computed
deterministically via `git diff --name-only` instead of parsing the pull banner.

### 17. VIEW ONCE ENGINE, ANTI DELETE ENGINE & PERSONAL STATUS PLATFORM ✅
Centralized `whatsapp/personal-engine.ts` — every capability verified against the
installed @crysnovax/baileys 2.7.0/2.7.1 fork source before implementation:

**View Once Engine** — `.vv` (recover view-once → resend as NORMAL media in chat),
`.vvdm` (recover → Saved Messages). Uses `downloadMediaMessage` with the fork's
`reuploadRequest` ctx (`socket.updateMediaMessage`, verified at messages-send.js) so
expired/view-once media actually downloads. Preserves caption, filename, mimetype,
quality; NEVER resends as view-once. `.autovv on|off` — per-chat automatic recovery.

**Anti Delete Engine** — `.antidelete on|dm|link <dest>|off`, isolated per chat.
Rolling cache of every incoming message (capped 500/session); recovery on BOTH the
`messages.update` protocolMessage REVOKE (type 0) path and `messages.delete` keys.
`on` reposts in the same chat · `dm` sends to Saved Messages with Chat/Sender/Sent/
Deleted/Type metadata · `link` forwards to a validated group JID or invite link.
Recovers text, images, videos, voice notes, audio, stickers, documents, contacts,
polls, locations. Never resurrects the bot's own deletions; recovered once only.

**Personal Status Platform** — `.pstatus <text>` or reply media (image/video/audio/
document) uploads to `status@broadcast` (verified fork send path). Sticker statuses
are rejected with a clear note (WhatsApp Status doesn't support them). Posted
statuses are tracked in memory for AutoSend.

**AutoSend** — `.autosend on|off` (per session). When someone replies to one of my
statuses with a request ("send", "please send" …), the ORIGINAL status content is
sent to them; duplicates ignored.

**AutoDownloadStatus** — `.autodstatus on|off` (per session). Contacts' statuses are
downloaded (with reupload ctx) and forwarded to my Saved Messages with Contact/Push
name/Phone/Posted/Type metadata. Duplicate ids ignored.

**Status Save** — `.sstatus` (reply to any contact status → recover into this chat)
and `.sstatus dm` (→ Saved Messages). The old `.sstatus` infinite status loop moved
to `.spam` (stop with `.stop spam`); `.sstatus` now follows the new spec.

**AutoStatusReact** — `.autostatusreact on|off [emoji]`. The fork has no
`sendReaction` helper, but `sendMessage({ react: … })` is natively supported
(messages-send.js:1051) — the same verified packet path the existing auto-like
uses. Real native reaction packet, never a chat reply.

**AntiGStatus** — `.antigstatus <delete|warn N|kick|off>` integrated into the Anti
System as a first-class module (GroupAntiConfig + ModuleKey + moduleLabel + the
shared warn-count/executeAction pipeline). Detects Group Status posts via the raw
groupStatusMessage/V2 wrapper or `contextInfo.isGroupStatus`, respects permit list
and the protected-participant guard.

**Config isolation** — all new settings persist in `engine-config.json` (per session
folder) with per-chat (autoVV, antiDelete) and per-session (autoSend, autodstatus,
autoStatusReact) keys — zero leakage between chats/groups/sessions.

**Global Sudo & Omni Owner → Telegram-only** — removed the WhatsApp command surface
(`.globalsudo/.setglobalsudo/.delglobalsudo/.omni/.setomni/.delomni`) from the
registry, menu and dispatch. Management now lives in the Telegram admin panel:
`👑 Global Sudo` / `🛡 Omni Owner` buttons with list + add/remove via text input.
The platform layers still auto-merge into every session (workspace.ts unchanged).

**Status routing fix** — incoming `status@broadcast` messages are now consumed by the
status pipeline BEFORE anti-checks and command parsing (they could previously be
parsed as commands — a latent bug).

Validated: `pnpm typecheck` clean + runtime smoke tests (config isolation, view-once
unwrap, self-jid, antidelete setters/validation, pstatus posting, autosend detection
+ dedupe, autodstatus + native react + dedupe).

## Remaining Work
1. Live-field verification on a real WhatsApp session: menu hub buttons → category sheets →
   command help cards → Prev/Next/Home; `.ping` native table rendering across Android/Web/iOS.
2. If a client fails to render the GenAI table, confirm the compact-card fallback fires (it is
   wired in PreviewDispatcher).
3. After the next deploy, confirm `pnpm install` resolves `@crysnovax/baileys@2.7.1` and the
   update-bot summary shows the correct files-changed count.

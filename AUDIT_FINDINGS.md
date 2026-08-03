# Key Audit Findings

## Baileys Version
- `@crysnovax/baileys` v2.7.0

## Current Defaults (workspace.ts)
- `publicMode: false` — needs to become `true`
- `tagReply: true` — already correct
- `permissionDeniedResponse: 'Permission denied. This command is restricted to owners and sudo users.'`

## Public Mode Permission Check (event-handlers.ts:536-551)
- Currently only allows: `['menu', 'help', 'gmenu', 'pair']`
- Need to remove 'help' from public list → only `menu`, `gmenu`, `pair`

## Global URL Buttons (PreviewDispatcher.ts + url-buttons.ts)
- `parseUrlButtons` at url-buttons.ts:20-29: parses `label|url` format, falls back to `Open N` when no label
- `applyGlobalPipeline` in PreviewDispatcher.ts:118-157: merges buttons into `nativeFlow.buttons`
- Issue: When label is empty, it falls back to `Open N` instead of using the URL itself
- `getGlobalMenuUrl()` returns platform-wide `globalMenuUrls` array joined by newline

## Session Connected Notifications (session.ts + socket-manager.ts)
- `onConnected` callback in socket-manager.ts:260-294 fires on every connection
- Telegram notification: already implemented in session.ts handlers (3 places, duplicated)
- WhatsApp DM: already sends `connectedCard()` to paired number
- Need to centralize and enhance: add Device, Connection Time, Status, Bot Version, Website

## AntiGM (anti-gm.ts)
- Currently checks for `groupStatusMentionMessage` in message object
- The issue: `runAntiChecks` only processes `messages.upsert` events for group messages
- AntiGM should ONLY react to native WhatsApp Status group mention events
- The module logic looks correct but it runs inside the general anti-check pipeline

## AntiLink (anti-link.ts)
- Already filters out CDN URLs and voice note false positives (lines 35-39)
- Only checks `conversation`, `extendedTextMessage.text`, `caption` fields
- Voice notes don't have captions, so they're already safe
- But: the module runs even when message has no text — should add early exit

## AntiGStatus (not yet found as separate module)
- Need to identify what detects automated group status posting
- The `.allstatus` command posts to group statuses
- AntiGStatus should detect other bots doing the same

## Socket Event Subscription (socket-manager.ts:391-398)
- Currently forwards: messages.upsert, messages.update, groups.update, group-participants.update, presence.update, contacts.update
- Missing: status events, interactive message events, call events

## Welcome/Goodbye (anti-system/index.ts:349-451)
- Uses `group-participants.update` events — correct
- Handles add/remove/promote/demote actions
- LID resolution already implemented
- AutoBlock already implemented

## Menu Tips
- Currently `whatsappMenu()` in ascii-art.ts has no tips section
- Need to add rotating tips at the bottom of all menus

## Types (types/index.ts)
- `publicMode?: boolean` — optional, needs default change
- `tagReply?: boolean` — optional, needs default change
- No `welcomeSent` or `connectedNotified` flags in SessionMeta — need to add for one-time DM

## Button System
- Admins can configure via Telegram: `Label|URL` format
- `setGlobalMenuUrl()` stores multiple URLs in `globalMenuUrls` array
- `parseUrlButtons()` correctly parses `label|url` format
- The `Open N` fallback is the bug — when no label provided, should use URL or skip

# OMEGA WA-Bridge

A production-grade Telegram ↔ WhatsApp automation bridge with multi-session management, mass outreach, link validation, and a built-in group moderation engine (Anti System).

## Run & Operate

- **WA-Bridge Bot** workflow: `pnpm --filter @workspace/wa-bridge run dev` — starts the Telegram bot + WhatsApp engine (hot-reload via tsx watch)
- `pnpm --filter @workspace/wa-bridge run typecheck` — typecheck the bot package
- `pnpm run build` — typecheck + build all packages
- On first run, the bot prompts for `TELEGRAM_BOT_TOKEN` and writes it to `.env`

## Required Secrets

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (from @BotFather) |
| `TELEGRAM_OWNER_ID` | Your Telegram numeric user ID |
| `TELEGRAM_OWNER_USERNAME` | Your Telegram username (without @) |

Optional: `REDIS_HOST` / `REDIS_PORT` (BullMQ workers; bot is fully functional without Redis).
Optional: `ANTI_NSFW_API_URL` (external NSFW detection endpoint for AntiNSFW module).

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5.9
- WhatsApp: @crysnovax/baileys (multi-device)
- Telegram: Telegraf
- Queue: BullMQ + ioredis (optional)
- Build: esbuild (ESM bundle)

## Where things live

```
artifacts/wa-bridge/src/
  whatsapp/
    event-handlers.ts       — message routing & all command dispatch
    command-parser.ts       — ALL_COMMANDS registry + prefix parsing
    socket-manager.ts       — per-session Baileys socket lifecycle
    anti-system/            — ◈ Anti System moderation engine
      index.ts              — runAntiChecks() + handleParticipantUpdate()
      types.ts              — AntiModuleConfig, GroupAntiConfig, etc.
      config.ts             — per-group config storage, warn counts, spam windows
      actions.ts            — kick / warn / delete action executor
      response.ts           — @mention, &gcname, &desc, &getpp template renderer
      commands.ts           — all anti command handlers (return reply strings)
      modules/              — one file per anti module (antilink, antibot, …)
  telegram/                 — Telegram bot handlers
  services/workspace.ts     — per-user workspace I/O
  utils/ascii-art.ts        — WhatsApp message formatters
workspaces/{tgId}/sessions/{sessionId}/
  anti-groups.json          — per-group Anti System config (written at runtime)
```

## Anti System Commands

| Command | Description |
|---|---|
| `.antilink kick\|warn N\|delete` | Block all links in the group |
| `.antibot kick\|warn\|delete` | Remove automation clients |
| `.antispam kick\|warn\|delete` | Rate-limit spammers (default 10 msg/5s) |
| `.spamlimit <n> <sec>` | Adjust spam rolling window |
| `.antipic / .antivid / .antiaud` | Block images / videos / audio |
| `.antivn` | Block voice notes |
| `.antitxt` | Block plain text |
| `.antiemoji / .antisticker` | Block emoji or sticker messages |
| `.antigroupcall` | Block group calls |
| `.antinsfw` | External NSFW detection (needs `ANTI_NSFW_API_URL`) |
| `.antigroupmention` | Block @group / channel mentions |
| `.antiwords kick\|warn\|delete` | Block custom word list |
| `.antiaddword <word>` | Add a blocked word |
| `.antirmword <word>` | Remove a blocked word |
| `.antiwordlist` | Show current blocked words |
| `.antipoll / .antiforward / .antichannel` | Block polls / forwards / channel reposts |
| `.antipromote / .antidemote <mode>` | Guard admin changes |
| `.antistatus` | Overview of all anti modules in the group |
| `.<module>permit @user` / `.rm<module>permit` | Exempt / un-exempt a user |
| `.<module>msg <text>` | Set custom violation response |

All modules use `<command> off` to disable. Response templates support `@mention`, `&gcname`, `&desc`, `&getpp`.

## Architecture decisions

- **Anti System runs before command parsing** — violations are caught and actioned before the command dispatcher sees the message, so banned content never accidentally triggers a command.
- **Per-group JSON config** — each group's anti settings are isolated in `anti-groups.json` inside the session directory; no shared global state between groups or users.
- **In-memory warn counts + spam windows** — fast, zero-latency; trade-off is counts reset on restart (a follow-up task covers persistence).
- **Concurrent actions** — delete + kick/notify run via `Promise.allSettled` to minimize latency and avoid one failure blocking the other.
- **Error isolation** — each anti module is individually wrapped in try-catch; one broken detector can never silence the others.

## User preferences

- Status cards should stay compact: use the URL's title and Omega design only; omit web/URL descriptions because they can make WhatsApp statuses too long.

## Gotchas

- The `group-participants.update` event must be forwarded from `socket-manager.ts` to `handleWAEvent` for AntiPromote/AntiDemote to work — confirm this is wired in `socket-manager.ts` if those modules don't trigger.
- AntiNSFW is fail-open (returns false) when `ANTI_NSFW_API_URL` is not set.
- 4 pre-existing TypeScript errors exist in `telegram/bot.ts`, `telegram/handlers/session.ts`, and `whatsapp/commands/mass-outreach.ts` — they don't affect the dev server but block a strict production build (Task #3 covers fixing them).

# OMEGA WA-Bridge

> **Production-grade Telegram ↔ WhatsApp automation bridge** — multi-device session management, intelligent mass outreach, real-time link validation, and a premium Gothic/Cyber control interface.

---

## ✦ What It Is

OMEGA WA-Bridge lets you control one or many WhatsApp accounts entirely through Telegram. Connect sessions via QR or pairing code, then run commands from Telegram or directly inside WhatsApp groups. A built-in web dashboard shows live session health.

**Key capabilities:**
- 📱 **Multi-session** — manage unlimited WhatsApp accounts per user
- 📡 **Mass outreach** — broadcast status/messages to all groups with anti-ban throttling
- 🔗 **Link validator hub** — validate thousands of invite links with a live streaming dashboard
- 🚪 **Smart join engine** — randomized queue, configurable pacing, automatic restriction detection
- 🔐 **Sudo system** — grant command access by number, reply, or @mention
- 🌐 **Omni-bridge** — run commands across all sessions simultaneously (owner only)

---

## ✦ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Telegram Bot (Telegraf)               │
│   /sessions  /bucket  /admin  /help  bridge mode        │
└────────────────────────┬────────────────────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │       Core Engine             │
         │  WorkspaceManager  │  Queue   │
         │  SocketManager     │ (BullMQ) │
         └───┬───────────────┬───────────┘
             │               │
   ┌─────────▼────┐   ┌──────▼──────────┐
   │  Baileys WA  │   │  Redis Workers  │
   │  (per-session│   │  Outreach       │
   │   sockets)   │   │  Validator      │
   └─────────────-┘   │  Lifecycle      │
                      │  Omni           │
                      └─────────────────┘
```

**Workspace layout** (one per Telegram user):
```
workspaces/{telegramId}/
  config.json           # User-level config, sudo numbers, prefix
  buckets/
    main.json           # Unvalidated invite links
    active.json         # Validated live links
    dead.json           # Expired / revoked links
  sessions/{sessionId}/
    auth/               # Baileys auth state (keys + creds)
    meta.json           # Session status, join-manager state
    config.json         # Session-level overrides
```

---

## ✦ Tech Stack

| Layer | Technology |
|-------|-----------|
| Telegram interface | [Telegraf](https://telegraf.js.org/) v4 |
| WhatsApp protocol | [@crysnovax/baileys](https://github.com/WhiskeySockets/Baileys) |
| Job queue | [BullMQ](https://bullmq.io/) + Redis |
| Runtime | Node.js 24, TypeScript 5.9 |
| Build | esbuild (ESM → CJS) |
| Web dashboard | Express 5 + vanilla JS |

---

## ✦ Setup

### 1 — Prerequisites

- Node.js 20+ (24 recommended)
- pnpm 9+
- Redis (optional — bot degrades gracefully without it)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### 2 — Clone & Install

```bash
git clone https://github.com/pappy999666-dotcom/omega-v1
cd omega-v1
pnpm install
```

### 3 — Configure Environment

```bash
cp artifacts/wa-bridge/.env.example artifacts/wa-bridge/.env
```

Edit `.env` and fill in **at minimum**:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_OWNER_ID=your_telegram_numeric_id
TELEGRAM_OWNER_USERNAME=your_username
```

Full `.env` reference:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `TELEGRAM_OWNER_ID` | ✅ | Your Telegram numeric user ID |
| `TELEGRAM_OWNER_USERNAME` | ✅ | Your Telegram username (no @) |
| `TELEGRAM_ADMIN_GROUP_ID` | — | Group for support routing |
| `TELEGRAM_SPONSOR_CHANNEL` | — | Force-join gatekeeping channel |
| `REDIS_HOST` | — | Redis host (default: 127.0.0.1) |
| `REDIS_PORT` | — | Redis port (default: 6379) |
| `REDIS_PASSWORD` | — | Redis password |
| `WORKSPACE_ROOT` | — | Per-user sandbox root path |
| `MAX_SESSIONS_PER_USER` | — | Session limit (default: 5) |
| `ALLSTATUS_MIN_DELAY_MS` | — | Min broadcast delay (default: 4000ms) |
| `ALLSTATUS_MAX_DELAY_MS` | — | Max broadcast delay (default: 9000ms) |
| `LOG_LEVEL` | — | `error`\|`warn`\|`info`\|`debug` |
| `LOG_DIR` | — | Log directory path |

### 4 — Run (Development)

```bash
pnpm --filter @workspace/wa-bridge run dev
```

The bot starts, connects to Redis (or skips with a warning), and sends a startup message to `TELEGRAM_OWNER_ID`.

### 5 — Build (Production)

```bash
pnpm --filter @workspace/wa-bridge run build
# Output: artifacts/wa-bridge/dist/index.js
node artifacts/wa-bridge/dist/index.js
```

---

## ✦ First Use

1. Open Telegram, find your bot, send `/start`
2. Go to **Sessions** → **Add New Session**
3. Enter your WhatsApp number → choose **Pairing Code** or **QR**
4. Enter the code in WhatsApp → **Linked Devices → Link a Device**
5. Session connects. You can now use the bot or run commands inside WhatsApp groups

---

## ✦ WhatsApp Commands

All commands use the configured prefix (default `.`). Run `.help` in any group to see the full menu.

### System

| Command | Description |
|---------|-------------|
| `.ping` | Latency check |
| `.info` | Session status, groups, config |
| `.groups` | List joined groups |
| `.menu` / `.help` | Full command reference |

### Sudo Access

| Command | Description |
|---------|-------------|
| `.sudo` | List authorized numbers |
| `.setsudo +2348012345678` | Grant command access by number |
| `.setsudo` *(reply to msg)* | Grant access to quoted message sender |
| `.setsudo` *(@mention)* | Grant access to @mentioned user |
| `.delsudo +2348012345678` | Revoke command access |

### Status Engine

| Command | Description |
|---------|-------------|
| `.gstatus [msg]` | Post to current group's status |
| `.allstatus [msg]` | Broadcast to every group's status |
| `.sstatus [msg]` | Run continuous status loop |
| `.stopspam` | Kill the active loop |
| `.settheme [theme]` | Set status design theme |
| `.statusdesign [theme] [url]` | Post designed status card |

### Lifecycle

| Command | Description |
|---------|-------------|
| `.join [link]` | Join a single group |
| `.joinall` | Join all active bucket links (randomized) |
| `.leave [jid/link]` | Leave a group |
| `.left` | Leave the current group |
| `.leaveall` | Leave all joined groups |

### Tag Engine

| Command | Description |
|---------|-------------|
| `.tag [msg]` | Hidetag-mention all members |
| `.mtag [msg]` | Visible-mention all members in chunks |

### Pair New Session

```
.pair +2348012345678
```
Pairs a new WhatsApp number directly from within a WhatsApp group. No need to open Telegram.

---

## ✦ Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Main menu |
| `/sessions` | Manage WhatsApp sessions |
| `/bucket` | Link validator hub |
| `/help` | Command reference |
| `/admin` | Platform governance (owner only) |

---

## ✦ Live Validator Dashboard

When validation runs, a live dashboard streams directly in Telegram:

```
┌─────────────────────────────┐
│ ◈ OMEGA VALIDATOR           │
│                             │
│ Queue      1,274            │
│ Live       863              │
│ Dead       245              │
│ Pending    166              │
│                             │
│ Session    #01              │
│ Status     ● ONLINE         │
│ Speed      37 links/min     │
└─────────────────────────────┘
```

**Session failover**: if the active session gets rate-limited, the validator automatically switches to the next healthy session without interrupting the queue.

---

## ✦ Smart Join Engine

The join manager processes the active bucket with intelligent scheduling:

- **Randomized order** — links are Fisher-Yates shuffled on every run (no predictable patterns)
- **Configurable pacing** — min/max delay, max links per run, retry count
- **Restriction detection** — classifies errors as: restriction, dead link, already joined, group full, network, unknown
- **Auto-stop** — stops after 5 consecutive restriction failures to protect the account

---

## ✦ Sudo System

Three ways to authorize a number:

```
# By raw phone number
.setsudo +2348012345678

# By replying to their message
[reply to message] .setsudo

# By @mentioning them
.setsudo @1234567890
```

Sudo users can run all ordinary WhatsApp commands. The session owner (the paired number) always has full access.

---

## ✦ Project Structure

```
omega-v1/
├── artifacts/
│   ├── wa-bridge/          # Main bot application
│   │   ├── src/
│   │   │   ├── index.ts              # Bootstrap & shutdown
│   │   │   ├── telegram/
│   │   │   │   ├── bot.ts            # Telegraf setup, all handlers
│   │   │   │   ├── handlers/
│   │   │   │   │   ├── session.ts    # Session pair/freeze/bridge
│   │   │   │   │   ├── bucket.ts     # Validator hub UI
│   │   │   │   │   └── admin.ts      # Platform governance
│   │   │   │   ├── middlewares/auth.ts
│   │   │   │   └── ui/keyboards.ts
│   │   │   ├── whatsapp/
│   │   │   │   ├── socket-manager.ts # Baileys lifecycle
│   │   │   │   ├── event-handlers.ts # WA command router
│   │   │   │   └── commands/
│   │   │   │       ├── lifecycle.ts  # join/leave
│   │   │   │       ├── mass-outreach.ts
│   │   │   │       ├── status.ts
│   │   │   │       └── tag.ts
│   │   │   ├── services/
│   │   │   │   ├── workspace.ts      # Per-user I/O
│   │   │   │   ├── tri-bucket.ts     # Validator pipeline
│   │   │   │   ├── join-manager.ts   # Smart join engine
│   │   │   │   ├── queue.ts          # BullMQ setup
│   │   │   │   ├── circuit-breaker.ts
│   │   │   │   └── workers/          # BullMQ workers
│   │   │   └── utils/
│   │   │       ├── ascii-art.ts      # WhatsApp card formatters
│   │   │       ├── formatter.ts      # Telegram HTML formatters
│   │   │       └── logger.ts
│   │   └── .env.example
│   └── api-server/         # Companion REST API (optional)
└── lib/
    ├── db/                 # Drizzle ORM schema
    ├── api-spec/           # OpenAPI spec
    └── api-client-react/   # Generated React hooks
```

---

## ✦ Logging

Logs rotate daily under `LOG_DIR` (default `./logs`):

```
logs/
  wa-bridge-2026-07-25.log   # Application logs
  errors-2026-07-25.log      # Error-only stream
```

Set `LOG_LEVEL=debug` to see full Baileys socket events.

---

## ✦ Development Notes

- **Typecheck**: `pnpm --filter @workspace/wa-bridge run typecheck`
- **Build**: `pnpm --filter @workspace/wa-bridge run build`
- **Dev (hot reload)**: `pnpm --filter @workspace/wa-bridge run dev`
- Auth state is written to `workspaces/{telegramId}/sessions/{sessionId}/auth/` — never commit this directory
- Redis is optional: all queue-backed bulk operations (BullMQ workers) are skipped when Redis is unavailable, but the bot remains fully functional for direct WhatsApp commands

---

## ✦ License

MIT — use freely, build responsibly.

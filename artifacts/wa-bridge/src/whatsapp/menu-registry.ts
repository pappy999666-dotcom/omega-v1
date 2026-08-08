// ============================================================
// WA-Bridge — Menu Registry
//
// Single source of truth for every command's section, syntax,
// description, and which menu it belongs to.
//
// The MENU NAVIGATION HUB at the bottom of this file derives every
// category from MENU_CATALOG + ALL_COMMANDS, so new commands appear
// automatically — no manual menu edits.
//
//
// HOW TO ADD A NEW COMMAND:
//   1. Add the command name to ALL_COMMANDS in command-parser.ts
//   2. Add a case in the switch in event-handlers.ts
//   3. Add one entry below — set target: 'group' for group-only
//      commands, 'main' for global commands, 'both' for both menus.
//
// .menu    → shows 'main' + 'both' commands
// .gmenu   → shows 'group' + 'both' commands
//
// Commands not listed here fall into "◈ OTHER" automatically.
// Set hidden: true for aliases / internal commands to suppress them.
// ============================================================

import { singleSelectButton } from './utils/native-rich.js';
import type { NativeListRow, NativeListSection } from './utils/native-rich.js';

export interface MenuEntry {
  /** Section heading (shared entries are grouped together) */
  section: string;
  /** Display syntax — prefix is prepended at render time */
  syntax: string;
  /** One-line description shown under the command */
  desc: string;
  /** Detailed explanation of what it does */
  usage?: string;
  /** Required permissions (Owner, Sudo, Admin, etc.) */
  permissions?: string;
  /** Supported inputs (Reply, Mention, Phone, etc.) */
  inputs?: string[];
  /** Examples of usage */
  examples?: string[];
  /** Optional arguments description */
  args?: string;
  /** Expected output description */
  output?: string;
  /** Alternate command names shown by the help engine. */
  aliases?: string[];
  /** Important caveats or supported options shown by the help engine. */
  notes?: string[];
  /** Which menu this entry appears in: 'main' | 'group' | 'both' */
  target?: 'main' | 'group' | 'both';
  /** Optional navigation domain used to build complete category pages. */
  navCategory?: 'status';
  /** If true, the command is never shown in any menu */
  hidden?: boolean;
}

/** Full catalog — maps command name → menu entry */
export const MENU_CATALOG: Record<string, MenuEntry> = {

  // ── Status Engine ──────────────────────────────────────────
  godcast: { section: '⚔ MODERATION', syntax: 'godcast', desc: 'Post designed status for current group', target: 'main', navCategory: 'status' },
  statusdesign: { section: '⚔ MODERATION', syntax: 'statusdesign', desc: 'Post designed status for current group', target: 'main', navCategory: 'status' },
  settheme: { section: '⚔ MODERATION', syntax: 'settheme [theme]', desc: 'Set default status theme for this group', target: 'main', navCategory: 'status' },
  smedia: { section: '⚔ MODERATION', syntax: 'smedia', desc: 'Post media status', target: 'main', navCategory: 'status' },
  gstatus: { section: '⚔ MODERATION', syntax: 'gstatus [msg]', desc: 'Post text to current group status', target: 'main', navCategory: 'status' },
  tochat: { section: '⚔ MODERATION', syntax: 'tochat [jid] [msg]', desc: 'Send message to a target group', target: 'main' },
  togstatus: { section: '⚔ MODERATION', syntax: 'togstatus [jid] [msg]', desc: 'Post to a target group status', target: 'main', navCategory: 'status' },
  tochatx: { section: '⚔ MODERATION', syntax: 'tochatx [jid] [n] [msg]', desc: 'Repeat a message to a target group', target: 'main' },
  togstatusx: { section: '⚔ MODERATION', syntax: 'togstatusx [n] [jid] [msg]', desc: 'Repeat to a target group status', target: 'main', navCategory: 'status' },
  sstatus: { section: '📲 STATUS PLATFORM', syntax: 'sstatus [dm]', desc: 'Save a replied contact status (or .sstatus dm)', target: 'both', navCategory: 'status',
    usage: 'Reply to any contact status to recover it.\n.sstatus — send back into this chat\n.sstatus dm — send to your Saved Messages',
    permissions: 'Owner / Sudo',
    inputs: ['Reply (contact status)'],
    examples: ['sstatus', 'sstatus dm'],
    output: 'Recovered status media/text sent.' },
  vv: { section: '📲 STATUS PLATFORM', syntax: 'vv', desc: 'Recover a View Once image/video (reply)', target: 'both', navCategory: 'status',
    usage: 'Reply to a View Once image or video to recover the original media and resend it as a normal message.',
    permissions: 'Owner / Sudo',
    inputs: ['Reply (View Once)'],
    examples: ['vv'],
    output: 'Media resent as normal (view-once removed).' },
  vvdm: { section: '📲 STATUS PLATFORM', syntax: 'vvdm', desc: 'Recover View Once to your Saved Messages', target: 'both', navCategory: 'status',
    usage: 'Reply to a View Once message. Recovers the media and sends it privately to your own WhatsApp account.',
    permissions: 'Owner / Sudo',
    inputs: ['Reply (View Once)'],
    examples: ['vvdm'],
    output: 'Media sent to Saved Messages.' },
  autovv: { section: '📲 STATUS PLATFORM', syntax: 'autovv <on|off>', desc: 'Auto-recover every view-once in this chat', target: 'both', navCategory: 'status',
    usage: 'When enabled in a chat, every View Once received is automatically recovered and resent as normal media.',
    permissions: 'Owner / Sudo',
    examples: ['autovv on', 'autovv off'],
    output: 'Per-chat setting persisted.' },
  antidelete: { section: '📲 STATUS PLATFORM', syntax: 'antidelete <on|dm|link <dest>|off>', desc: 'Recover deleted messages', target: 'both', navCategory: 'status',
    usage: 'Recover messages deleted by participants.\non — repost in the same chat\ndm — send to your Saved Messages\nlink <jid|invite> — forward to a configured destination\noff — disable for this chat',
    permissions: 'Owner / Sudo',
    inputs: ['Reply', 'JID', 'Invite Link'],
    examples: ['antidelete on', 'antidelete dm', 'antidelete link 120363…@g.us', 'antidelete off'],
    output: 'Deleted messages recovered with sender/time/type metadata.' },
  pstatus: { section: '📲 STATUS PLATFORM', syntax: 'pstatus [text]', desc: 'Post to your personal WhatsApp Status', target: 'main', navCategory: 'status',
    usage: 'Post text or reply to media (image/video/audio/document) to upload it to your personal status.',
    permissions: 'Owner / Sudo',
    inputs: ['Text', 'Reply (media)'],
    examples: ['pstatus Hello World', 'pstatus (reply image)'],
    output: 'Status posted to status@broadcast.' },
  autosend: { section: '📲 STATUS PLATFORM', syntax: 'autosend <on|off>', desc: 'Auto-send status content on request', target: 'main', navCategory: 'status',
    usage: 'When someone replies to your status asking for it ("send", "please send"), the original content is sent to them.',
    permissions: 'Owner / Sudo',
    examples: ['autosend on', 'autosend off'],
    output: 'Session setting persisted.' },
  autodstatus: { section: '📲 STATUS PLATFORM', syntax: 'autodstatus <on|off>', desc: 'Auto-download contacts\' statuses to Saved Messages', target: 'main', navCategory: 'status',
    usage: 'Every contact status is downloaded and forwarded to your Saved Messages with contact/time/type metadata.',
    permissions: 'Owner / Sudo',
    examples: ['autodstatus on', 'autodstatus off'],
    output: 'Statuses archived with metadata.' },
  autostatusreact: { section: '📲 STATUS PLATFORM', syntax: 'autostatusreact <on|off> [emoji]', desc: 'Native reaction to viewed statuses', target: 'main', navCategory: 'status',
    usage: 'Automatically reacts to statuses you view using a native WhatsApp reaction packet (not a chat reply).',
    permissions: 'Owner / Sudo',
    examples: ['autostatusreact on', 'autostatusreact on 🔥', 'autostatusreact off'],
    output: 'Native status reactions applied.' },
  antigstatus: { section: '🛡 ANTI SYSTEM', syntax: 'antigstatus <delete|warn N|kick|off>', desc: 'Block unauthorized Group Status posts', target: 'group', navCategory: 'status',
    usage: 'Detect group status posting events and punish unauthorized posters (respects permits and admin exemption).',
    permissions: 'Admin / Sudo / Owner',
    examples: ['antigstatus delete', 'antigstatus warn 3', 'antigstatus kick', 'antigstatus off'],
    output: 'Violations deleted/warned/kicked with warn escalation.' },

  // ── Broadcast Network ─────────────────────────────────────
  allstatus: { section: '⚔ MODERATION', syntax: 'allstatus [msg]', desc: 'Post to ALL group statuses', target: 'main', navCategory: 'status' },
  allstatusx: { section: '⚔ MODERATION', syntax: 'allstatusx [n] [msg]', desc: 'Repeat to every group status', target: 'main', navCategory: 'status' },
  allchat: { section: '⚔ MODERATION', syntax: 'allchat [msg]', desc: 'Send to all groups with hidetag', target: 'main' },
  stopspam: { section: '⚔ MODERATION', syntax: 'stopspam', desc: 'Stop the active status / outreach loop', target: 'main', navCategory: 'status' },
  stop: { section: '⚔ MODERATION', syntax: 'stop', desc: 'Alias for stopspam', target: 'main', navCategory: 'status' },

  // ── Games ─────────────────────────────────────────────────
  wcg: { section: '🎮 GAMES', syntax: 'wcg', desc: 'Start a 40-second multiplayer Word Chain game', target: 'group',
    usage: 'Start a group lobby, then players send .join. Each turn requires an unused dictionary word beginning with the displayed letter.',
    permissions: 'Owner / Sudo',
    examples: ['wcg', 'join'],
    output: 'Scoped Word Chain session with mentions, timers and cleanup.' },
  ttt: { section: '🎮 GAMES', syntax: 'ttt @user', desc: 'Challenge a user to Tic-Tac-Toe', target: 'both', aliases: ['tictactoe'],
    usage: 'Challenge a mentioned user. The challenge must be accepted before moves begin. Use A1 through C3 for moves.',
    permissions: 'Owner / Sudo',
    inputs: ['@Mention'],
    examples: ['ttt @user', 'ttt accept', 'ttt A1', 'ttt giveup'],
    output: 'Text board with strict player/turn validation.' },
  tictactoe: { section: '🎮 GAMES', syntax: 'tictactoe @user', desc: 'Alias for Tic-Tac-Toe', target: 'both', hidden: true },

  // ── Poll Game Engine (AI-powered) ───────────────────────────
  wyr: { section: '🎮 GAMES', syntax: 'wyr [duration]', desc: 'AI Would You Rather poll game', target: 'group',
    usage: 'Generates a fresh Would You Rather question with the configured Game AI and creates a real WhatsApp poll. Duration defaults to 60s; minimum 30s.',
    permissions: 'Owner / Sudo',
    examples: ['wyr', 'wyr 30s', 'wyr 2min', 'wyr 5min'],
    args: 'Optional duration: 30s | 1min | 2min | 5min',
    output: 'Native poll + results table with player mentions.' },
  quiz: { section: '🎮 GAMES', syntax: 'quiz <duration>', desc: 'AI multi-question Quiz poll game', target: 'group',
    usage: 'Splits the duration into question intervals (e.g. 15min → 3 questions × 5min). Minimum 5 minutes.',
    permissions: 'Owner / Sudo',
    examples: ['quiz 5min', 'quiz 10min', 'quiz 15min', 'quiz 1h'],
    args: 'Duration: 5min | 10min | 15min | 1h',
    output: 'Sequential quiz polls, answer reveals, top-5 leaderboard, final result.' },
  stopwyr: { section: '🎮 GAMES', syntax: 'stopwyr', desc: 'Stop the active WYR game in this group', target: 'group',
    usage: 'Stops only the WYR game running in the current group/session. Timers, vote tracking and saved state are cleared.',
    permissions: 'Owner / Sudo',
    examples: ['stopwyr'],
    output: 'Active WYR game stopped.' },
  stopquiz: { section: '🎮 GAMES', syntax: 'stopquiz', desc: 'Stop the active Quiz game in this group', target: 'group',
    usage: 'Stops only the Quiz game running in the current group/session. Timers, vote tracking and saved state are cleared.',
    permissions: 'Owner / Sudo',
    examples: ['stopquiz'],
    output: 'Active Quiz game stopped.' },
  gameapi: { section: '🎮 GAMES', syntax: 'gameapi [key] | gameapi model <model> | gameapi endpoint <url|groq|xai|openai>', desc: 'Configure the per-session Game AI key', target: 'both', hidden: true,
    usage: 'Sets the AI key used for game content (.wyr / .quiz) for THIS WhatsApp session only. Stored privately and never shown again. Default provider is Groq (llama-3.3-70b-versatile). Use .gameapi model <model> to override the model and .gameapi endpoint <url|groq|xai|openai> to pick any OpenAI-compatible provider (Grok, OpenAI, ...). Use .gameapi guide for the full per-session setup tutorial. Credentials never fall back across sessions.',
    permissions: 'Owner / Sudo',
    examples: ['gameapi gsk_1234...', 'gameapi model llama-3.3-70b-versatile', 'gameapi endpoint xai', 'gameapi clear', 'gameapi guide'],
    output: 'Confirmation with masked key status.' },

  // ── Tag Engine ────────────────────────────────────────────
  tag: { section: '📊 UTILITY', syntax: 'tag', desc: 'Hidetag all group members', target: 'both' },
  mtag: { section: '📊 UTILITY', syntax: 'mtag', desc: 'Visibly mention all group members', target: 'both' },

  // ── Lifecycle ─────────────────────────────────────────────
  join: { section: '📊 UTILITY', syntax: 'join [link]', desc: 'Join a group by invite link', target: 'main' },
  left: { section: '📊 UTILITY', syntax: 'left', desc: 'Leave the current group', target: 'main' },
  leave: { section: '📊 UTILITY', syntax: 'leave [jid]', desc: 'Leave a specific group by JID', target: 'main' },
  joinall: { section: '📊 UTILITY', syntax: 'joinall', desc: 'Join every link in the active bucket', target: 'main' },
  leaveall: { section: '📊 UTILITY', syntax: 'leaveall', desc: 'Leave all joined groups', target: 'main' },

  // ── Pairing ───────────────────────────────────────────────
  ls: { section: '⚙ CONFIGURATION', syntax: 'ls', desc: 'List all WhatsApp sessions', target: 'main' },
  curr: { section: '⚙ CONFIGURATION', syntax: 'curr', desc: 'Show the current active session', target: 'main' },
  switch: { section: '⚙ CONFIGURATION', syntax: 'switch [id]', desc: 'Switch to a different session', target: 'main' },
  sinfo: { section: '⚙ CONFIGURATION', syntax: 'sinfo [id]', desc: 'Show detailed session information', target: 'main' },
  restart: { section: '⚙ CONFIGURATION', syntax: 'restart [id]', desc: 'Hot-reload/reconnect a session', target: 'main' },
  disconnect: { section: '⚙ CONFIGURATION', syntax: 'disconnect [id]', desc: 'Close a session without deleting data', target: 'main' },
  delete: { section: '⚙ CONFIGURATION', syntax: 'delete [id]', desc: 'Permanently remove a session and data', target: 'main' },
  rename: { section: '⚙ CONFIGURATION', syntax: 'rename [id] [name]', desc: 'Assign a custom label to a session', target: 'main' },
  freeze: { section: '⚙ CONFIGURATION', syntax: 'freeze [id]', desc: 'Pause all event processing for a session', target: 'main' },
  unfreeze: { section: '⚙ CONFIGURATION', syntax: 'unfreeze [id]', desc: 'Resume event processing for a session', target: 'main' },
  pair: { section: '⚙ CONFIGURATION', syntax: 'pair [phone]', desc: 'Link a new WhatsApp session via code', target: 'main',
    usage: 'Pair a new session via phone number.',
    permissions: 'Public',
    inputs: ['Phone Number'],
    examples: ['pair 1234567890'],
    output: 'Pairing code generated.' },

  // ── Bucket ────────────────────────────────────────────────
  addlink: { section: '📊 UTILITY', syntax: 'addlink [link…]', desc: 'Add invite links to the main bucket', target: 'main' },

  // ── System Config ─────────────────────────────────────────
  setprefix: { section: '⚙ CONFIGURATION', syntax: 'setprefix [p]', desc: 'Change the command prefix', target: 'main' },
  prefix: { section: '⚙ CONFIGURATION', syntax: 'prefix', desc: 'Show the current prefix', target: 'main' },
  sticker: { section: '🎨 STICKER ENGINE', syntax: 'sticker', desc: 'Convert image/video to sticker', target: 'both' },
  qc: { section: '🎨 STICKER ENGINE', syntax: 'qc [text] [--bg <preset|#hex|#hex,#hex>]', desc: 'Generate a bold text quote sticker', target: 'both',
    usage: 'Render any text as a premium bold sticker. Long text is auto-fitted and wrapped. Optional --bg flag sets a background preset, solid hex color, or two-color gradient.',
    permissions: 'Owner / Sudo',
    inputs: ['Text', 'Background Flag'],
    examples: ['qc TAG', 'qc OMEGA --bg ocean', 'qc HELLO --bg #ff5500', 'qc FIRE --bg #ff0000,#ff8800'],
    output: 'Canvas-generated 512×512 WebP sticker sent to the chat.' },
  tg: { section: '🎨 STICKER ENGINE', syntax: 'tg [link] [number]', desc: 'Download a whole Telegram sticker pack to WhatsApp', target: 'both',
    usage: 'Send a Telegram sticker pack link (or bare pack name) and the bot downloads & sends EVERY sticker in the pack. A "Total stickers found — downloading" card goes out first, then each sticker, then a summary. Append a number to grab just one sticker; post links (t.me/<channel>/<id>) also work.',
    permissions: 'Owner / Sudo',
    inputs: ['Telegram Link', 'Sticker Number'],
    examples: ['tg https://t.me/addstickers/StickerPackName', 'tg StickerPackName 3', 'tg https://t.me/stickerpack/7'],
    output: 'Progress card → every sticker → summary card.' },
  setpackname: { section: '🎨 STICKER ENGINE', syntax: 'setpackname [name]', desc: 'Set sticker pack name', target: 'main' },
  setauthor: { section: '🎨 STICKER ENGINE', syntax: 'setauthor [name]', desc: 'Set sticker author name', target: 'main' },
  setcmd: { section: '🎨 STICKER ENGINE', syntax: 'setcmd [cmd]', desc: 'Bind a quoted sticker to a command', target: 'main' },
  delcmd: { section: '🎨 STICKER ENGINE', syntax: 'delcmd', desc: 'Remove a sticker binding', target: 'main' },
  listcmd: { section: '🎨 STICKER ENGINE', syntax: 'listcmd', desc: 'List all sticker command bindings', target: 'main' },
  setmenupic: { section: '⚙ CONFIGURATION', syntax: 'setmenupic', desc: 'Set replied image as menu media', target: 'main' },
  setmenuvideo: { section: '⚙ CONFIGURATION', syntax: 'setmenuvideo', desc: 'Set replied video as menu media', target: 'main' },
  delmenumedia: { section: '⚙ CONFIGURATION', syntax: 'delmenumedia', desc: 'Restore default text-only menus', target: 'main' },
  setpfp: { section: '⚙ CONFIGURATION', syntax: 'setpfp', desc: 'Set the session profile picture from a replied image', target: 'main', inputs: ['Reply (Image)'] },
  getpfp: { section: '⚙ CONFIGURATION', syntax: 'getpfp', desc: 'Send the session profile picture', target: 'main' },
  removepfp: { section: '⚙ CONFIGURATION', syntax: 'removepfp', desc: 'Remove the session profile picture', target: 'main' },
  setname: { section: '⚙ CONFIGURATION', syntax: 'setname <name>', desc: 'Set the WhatsApp display name', target: 'main' },
  setbio: { section: '⚙ CONFIGURATION', syntax: 'setbio <text>', desc: 'Set the WhatsApp profile bio', target: 'main' },
  wainfo: { section: '⚙ CONFIGURATION', syntax: 'wainfo <target>', desc: 'Look up a WhatsApp contact or group', target: 'main' },
  creategc: { section: '⚙ CONFIGURATION', syntax: 'creategc <name> | <desc>', desc: 'Create a group and optionally set a replied image as its PFP', target: 'main' },
  collect: { section: '⚙ CONFIGURATION', syntax: 'collect <on|off>', desc: 'Toggle per-session invite-link collection', target: 'main' },
  autopromo: { section: '⚙ CONFIGURATION', syntax: 'autopromo <add|status|run|off>', desc: 'Manage per-session auto-promotion', target: 'main' },
  setsudo: { section: '⚙ CONFIGURATION', syntax: 'setsudo [number]', desc: 'Grant command access (or reply to msg)', target: 'main' },
  delsudo: { section: '⚙ CONFIGURATION', syntax: 'delsudo [number]', desc: 'Revoke command access', target: 'main' },
  sudo: { section: '⚙ CONFIGURATION', syntax: 'sudo', desc: 'List all sudo numbers', target: 'main' },
  public: { section: '⚙ CONFIGURATION', syntax: 'public [on|off]', desc: 'Legacy alias for setmode', target: 'main' },
  setmode: { section: '⚙ CONFIGURATION', syntax: 'setmode <public|private>', desc: 'Public = anyone may use commands; Private = authorized only (Pair always works)', target: 'main' },
  swresponse: { section: '⚙ CONFIGURATION', syntax: 'swresponse <txt|table>', desc: 'Switch response rendering mode (text or native table)', target: 'main' },
  settimezone: { section: '⚙ CONFIGURATION', syntax: 'settimezone <IANA>', desc: 'Set session timezone (e.g. Africa/Lagos)', target: 'main' },
  // Global Sudo & Omni Owner are managed from the Telegram admin panel only
  // (never exposed as WhatsApp commands).
  publicresponse: { section: '⚙ CONFIGURATION', syntax: 'publicresponse [text]', desc: 'Set the permission denied message', target: 'main' },
  tagreply: { section: '⚙ CONFIGURATION', syntax: 'tagreply [on|off]', desc: 'Enable/disable tagging in bot replies', target: 'main' },
  info: { section: '⚙ CONFIGURATION', syntax: 'info', desc: 'Session info and status', target: 'main' },
  groups: { section: '⚙ CONFIGURATION', syntax: 'groups', desc: 'List all joined groups', target: 'main' },
  ping: { section: '⚙ CONFIGURATION', syntax: 'ping', desc: 'Check bot latency', target: 'main',
    usage: 'Check bot latency and status.',
    permissions: 'Public',
    examples: ['ping'],
    output: 'Pong card with latency.' },
  jid: { section: '⚙ CONFIGURATION', syntax: 'jid', desc: 'Show the current group JID', target: 'main' },
  userinfo: { section: '⚙ CONFIGURATION', syntax: 'userinfo', desc: 'Show user JID, number & LID', target: 'main' },
  idea: { section: '⚙ CONFIGURATION', syntax: 'idea [msg]', desc: 'Send a suggestion or feedback to admin', target: 'both' },
  getinfo: { section: '⚙ CONFIGURATION', syntax: 'getinfo', desc: 'Alias for userinfo', target: 'main' },
  spam: { section: '⚔ MODERATION', syntax: 'spam [msg]', desc: 'Run status loop (until stopspam)', target: 'main', navCategory: 'status' },
  menu: { section: '⚙ CONFIGURATION', syntax: 'menu', desc: 'Show general command menu', target: 'main',
    usage: 'Show the main command menu.',
    permissions: 'Public',
    examples: ['menu'],
    output: 'Premium OS-style menu.' },
  help: { section: '⚙ CONFIGURATION', syntax: 'help [page]', desc: 'List every command in plain-text pages (no buttons)', target: 'main',
    usage: 'Show the complete command list. If it spans multiple messages, send .help 2, .help 3, and so on.',
    permissions: 'Public',
    examples: ['help', 'help 2'],
    output: 'Numbered command pages with a next-page instruction.' },
  gmenu: { section: '⚙ CONFIGURATION', syntax: 'gmenu', desc: 'Show group moderation menu', target: 'group' },

  // ── Group Moderation ──────────────────────────────────────
  kick: { section: '⚔ MODERATION', syntax: 'kick', desc: 'Kick member (reply / @mention / number)', target: 'group',
    usage: 'Kick a member from the group.',
    permissions: 'Admin / Sudo / Owner',
    inputs: ['Reply', '@Mention', 'Phone Number'],
    examples: ['kick @user', 'kick 1234567890'],
    output: 'Member removed from group.' },
  remove: { section: '⚔ MODERATION', syntax: 'remove', desc: 'Alias for kick', target: 'group' },
  dnkick: { section: '⚔ MODERATION', syntax: 'dnkick', desc: 'Demote then kick an admin safely', target: 'group' },
  ban: { section: '⚔ MODERATION', syntax: 'ban', desc: 'Locally restrict a member (stays in group, messages auto-deleted)', target: 'group',
    usage: 'Ban a member without kicking them.\nThe member stays in the group but every message they send is deleted until .unban.',
    permissions: 'Admin / Sudo / Owner',
    inputs: ['Reply', '@Mention', 'Phone Number'],
    examples: ['ban @user', 'ban 1234567890'],
    output: 'Local restriction active + ban message sent.' },
  setantiwords: { section: '🛡 ANTI SYSTEM', syntax: 'setantiwords <w1, w2, ...>', desc: 'Append blocked words (never overwrites)', target: 'group',
    usage: 'Add one or more blocked words. Duplicates ignored, case-insensitive, Unicode-safe.',
    permissions: 'Admin / Sudo / Owner',
    inputs: ['Comma-separated words'],
    examples: ['setantiwords scam', 'setantiwords scam,fraud,casino', 'setantiwords free money,loan'],
    output: 'Words appended + module enabled.' },
  rmantiwords: { section: '🛡 ANTI SYSTEM', syntax: 'rmantiwords <w1, w2, ...>', desc: 'Remove blocked words', target: 'group',
    usage: 'Remove one or more blocked words.',
    permissions: 'Admin / Sudo / Owner',
    examples: ['rmantiwords scam', 'rmantiwords scam,fraud'],
    output: 'Words removed from blocklist.' },
  clearantiwords: { section: '🛡 ANTI SYSTEM', syntax: 'clearantiwords', desc: 'Clear ALL blocked words (confirmation required)', target: 'group',
    usage: 'Remove every blocked word after confirmation.',
    permissions: 'Admin / Sudo / Owner',
    examples: ['clearantiwords', 'clearantiwords yes'],
    output: 'Blocklist emptied.' },
  unban: { section: '⚔ MODERATION', syntax: 'unban', desc: 'Remove a member from the ban list', target: 'group' },
  banlist: { section: '⚔ MODERATION', syntax: 'banlist', desc: 'View the ban list for this group', target: 'group' },
  promote: { section: '⚔ MODERATION', syntax: 'promote', desc: 'Grant admin to a member', target: 'group' },
  demote: { section: '⚔ MODERATION', syntax: 'demote', desc: 'Remove admin from a member', target: 'group' },
  warn: { section: '⚔ MODERATION', syntax: 'warn', desc: 'Issue a warning to a member', target: 'group' },
  unwarn: { section: '⚔ MODERATION', syntax: 'unwarn', desc: 'Clear one warning from a member', target: 'group' },
  resetwarn: { section: '⚔ MODERATION', syntax: 'resetwarn', desc: 'Reset all warnings for a member', target: 'group' },
  warns: { section: '⚔ MODERATION', syntax: 'warns', desc: 'Show warning count for a member', target: 'group' },
  poll: { section: '⚔ MODERATION', syntax: 'poll Q|A|B', desc: 'Create a group poll', target: 'group' },
  blockall: { section: '⚔ MODERATION', syntax: 'blockall', desc: 'Batch-kick all non-admin members', target: 'group' },
  autoblock: { section: '⚔ MODERATION', syntax: 'autoblock <on|off>', desc: 'Auto-kick every new joiner', target: 'group' },
  setwelcome: { section: '⚔ MODERATION', syntax: 'setwelcome [msg]', desc: 'Set welcome message (use off to disable)', target: 'group' },
  welcomemsg: { section: '⚔ MODERATION', syntax: 'welcomemsg [msg]', desc: 'Alias for setwelcome', target: 'group' },
  welcome: { section: '⚔ MODERATION', syntax: 'welcome', desc: 'Toggle welcome messages on/off', target: 'group' },
  setgoodbye: { section: '⚔ MODERATION', syntax: 'setgoodbye [msg]', desc: 'Set goodbye message (use off to disable)', target: 'group' },
  goodbyemsg: { section: '⚔ MODERATION', syntax: 'goodbyemsg [msg]', desc: 'Alias for setgoodbye', target: 'group' },
  goodbye: { section: '⚔ MODERATION', syntax: 'goodbye', desc: 'Toggle goodbye messages on/off', target: 'group' },
  kickmsg: { section: '⚔ MODERATION', syntax: 'kickmsg [text]', desc: 'Customise kick response message', target: 'group' },
  warnmsg: { section: '⚔ MODERATION', syntax: 'warnmsg [text]', desc: 'Customise warn response message', target: 'group' },
  banmsg: { section: '⚔ MODERATION', syntax: 'banmsg [text]', desc: 'Customise ban response message', target: 'group' },
  unbanmsg: { section: '⚔ MODERATION', syntax: 'unbanmsg [text]', desc: 'Customise unban response message', target: 'group' },
  eventstatus: { section: '⚔ MODERATION', syntax: 'eventstatus', desc: 'Group event config overview', target: 'group' },

  // ── Anti System — Overview ────────────────────────────────
  antistatus: { section: '🛡 ANTI SYSTEM', syntax: 'antistatus', desc: 'Show all anti modules status for this group', target: 'group' },

  // AntiLink
  antilink: { section: '🛡 ANTI SYSTEM', syntax: 'antilink <kick|warn N|delete|off>', desc: 'Block all links in the group', target: 'group' },
  linkpermit: { section: '🛡 ANTI SYSTEM', syntax: 'linkpermit @user', desc: 'Exempt a user from AntiLink', target: 'group' },
  rmlinkpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmlinkpermit @user', desc: 'Remove AntiLink exemption', target: 'group' },
  antilinkmsg: { section: '🛡 ANTI SYSTEM', syntax: 'antilinkmsg [text]', desc: 'Set custom AntiLink violation message', target: 'group' },

  // AntiBot
  antibot: { section: '🛡 ANTI SYSTEM', syntax: 'antibot <kick|warn N|delete|off>', desc: 'Remove automation/bot clients', target: 'group' },
  botpermit: { section: '🛡 ANTI SYSTEM', syntax: 'botpermit @user', desc: 'Exempt a user from AntiBot', target: 'group' },
  rmbotpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmbotpermit @user', desc: 'Remove AntiBot exemption', target: 'group' },

  // AntiSpam
  antispam: { section: '🛡 ANTI SYSTEM', syntax: 'antispam <kick|warn N|delete|off>', desc: 'Rate-limit spammers (default 10 msg/5s)', target: 'group' },
  spamlimit: { section: '🛡 ANTI SYSTEM', syntax: 'spamlimit <msgs> <secs>', desc: 'Adjust spam detection window', target: 'group' },
  spampermit: { section: '🛡 ANTI SYSTEM', syntax: 'spampermit @user', desc: 'Exempt a user from AntiSpam', target: 'group' },
  rmspampermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmspampermit @user', desc: 'Remove AntiSpam exemption', target: 'group' },
  antispammsg: { section: '🛡 ANTI SYSTEM', syntax: 'antispammsg [text]', desc: 'Custom AntiSpam message', target: 'group' },

  // AntiMedia
  antipic: { section: '🛡 ANTI SYSTEM', syntax: 'antipic <kick|warn N|delete|off>', desc: 'Block image messages', target: 'group' },
  antivid: { section: '🛡 ANTI SYSTEM', syntax: 'antivid <kick|warn N|delete|off>', desc: 'Block video messages', target: 'group' },
  antiaud: { section: '🛡 ANTI SYSTEM', syntax: 'antiaud <kick|warn N|delete|off>', desc: 'Block audio messages', target: 'group' },
  picpermit: { section: '🛡 ANTI SYSTEM', syntax: 'picpermit @user', desc: 'Exempt from AntiPic', target: 'group' },
  rmpicpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmpicpermit @user', desc: 'Remove AntiPic exemption', target: 'group' },
  vidpermit: { section: '🛡 ANTI SYSTEM', syntax: 'vidpermit @user', desc: 'Exempt from AntiVid', target: 'group' },
  rmvidpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmvidpermit @user', desc: 'Remove AntiVid exemption', target: 'group' },
  audpermit: { section: '🛡 ANTI SYSTEM', syntax: 'audpermit @user', desc: 'Exempt from AntiAud', target: 'group' },
  rmaudpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmaudpermit @user', desc: 'Remove AntiAud exemption', target: 'group' },

  // AntiVN
  antivn: { section: '🛡 ANTI SYSTEM', syntax: 'antivn <kick|warn N|delete|off>', desc: 'Block voice notes', target: 'group' },
  vnpermit: { section: '🛡 ANTI SYSTEM', syntax: 'vnpermit @user', desc: 'Exempt from AntiVN', target: 'group' },
  rmvnpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmvnpermit @user', desc: 'Remove AntiVN exemption', target: 'group' },
  antivnmsg: { section: '🛡 ANTI SYSTEM', syntax: 'antivnmsg [text]', desc: 'Custom AntiVN message', target: 'group' },

  // AntiText
  antitxt: { section: '🛡 ANTI SYSTEM', syntax: 'antitext <kick|warn N|delete|off>', desc: 'Block plain text messages only (no word list)', target: 'group' },
  antitext: { section: '🛡 ANTI SYSTEM', syntax: 'antitext <kick|warn N|delete|off>', desc: 'Alias for AntiText plain-text blocking', target: 'group', hidden: true },

  // AntiEmoji
  antiemoji: { section: '🛡 ANTI SYSTEM', syntax: 'antiemoji <kick|warn N|delete|off>', desc: 'Block emoji messages', target: 'group' },
  emojipermit: { section: '🛡 ANTI SYSTEM', syntax: 'emojipermit @user', desc: 'Exempt from AntiEmoji', target: 'group' },
  rmemojipermit:{ section: '🛡 ANTI SYSTEM',      syntax: 'rmemojipermit @user',       desc: 'Remove AntiEmoji exemption',                 target: 'group' },
  antiemojimsg: { section: '🛡 ANTI SYSTEM', syntax: 'antiemojimsg [text]', desc: 'Custom AntiEmoji message', target: 'group' },

  // AntiSticker
  antisticker: { section: '🛡 ANTI SYSTEM', syntax: 'antisticker <kick|warn N|delete|off>', desc: 'Block sticker messages', target: 'group' },
  sticpermit: { section: '🛡 ANTI SYSTEM', syntax: 'sticpermit @user', desc: 'Exempt from AntiSticker', target: 'group' },
  rmsticpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmsticpermit @user', desc: 'Remove AntiSticker exemption', target: 'group' },

  // AntiGroupCall
  antigroupcall:{ section: '🛡 ANTI SYSTEM',      syntax: 'antigroupcall <kick|warn N|delete|off>', desc: 'Block incoming group calls',           target: 'group' },

  // AntiNSFW
  antinsfw: { section: '🛡 ANTI SYSTEM', syntax: 'antinsfw <kick|warn N|delete|off>', desc: 'Block NSFW images & videos (needs API)', target: 'group' },
  nsfwpermit: { section: '🛡 ANTI SYSTEM', syntax: 'nsfwpermit @user', desc: 'Exempt from AntiNSFW', target: 'group' },
  rmnsfwpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmnsfwpermit @user', desc: 'Remove AntiNSFW exemption', target: 'group' },

  // AntiGroupMention
  antigroupmention: { section: '🛡 ANTI SYSTEM', syntax: 'antigroupmention <kick|warn N|delete|off>', desc: 'Block @group / channel mention blasts', target: 'group' },
  antigm: { section: '🛡 ANTI SYSTEM', syntax: 'antigm <kick|warn N|delete|off>', desc: 'Handle WhatsApp Status group mentions', target: 'group' },
  mentionpermit: { section: '🛡 ANTI SYSTEM', syntax: 'mentionpermit @user', desc: 'Exempt from AntiGroupMention', target: 'group' },
  rmmentionpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmmentionpermit @user', desc: 'Remove AntiGroupMention exemption', target: 'group' },

  // AntiWords
  antiwords: { section: '🛡 ANTI SYSTEM', syntax: 'antiwords <kick|warn N|delete|off> [words]', desc: 'Block only configured words/phrases', target: 'group',
    examples: ['antiwords warn 3 [scam, fraud, free money]', 'antiwords delete [casino]'],
    usage: 'AntiWords owns the bracketed word list. AntiText remains plain-text-only.',
  },
  antiaddword: { section: '🛡 ANTI SYSTEM', syntax: 'antiaddword <word>', desc: 'Add a word to the blocklist', target: 'group' },
  antirmword: { section: '🛡 ANTI SYSTEM', syntax: 'antirmword <word>', desc: 'Remove a word from the blocklist', target: 'group' },
  antiwordlist: { section: '🛡 ANTI SYSTEM', syntax: 'antiwordlist', desc: 'Show all blocked words', target: 'group' },
  antiwordsmsg: { section: '🛡 ANTI SYSTEM', syntax: 'antiwordsmsg [text]', desc: 'Custom AntiWords message', target: 'group' },

  // AntiPoll
  antipoll: { section: '🛡 ANTI SYSTEM', syntax: 'antipoll <kick|warn N|delete|off>', desc: 'Block poll creation', target: 'group' },
  pollpermit: { section: '🛡 ANTI SYSTEM', syntax: 'pollpermit @user', desc: 'Exempt from AntiPoll', target: 'group' },
  rmpollpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmpollpermit @user', desc: 'Remove AntiPoll exemption', target: 'group' },

  // AntiForward
  antiforward: { section: '🛡 ANTI SYSTEM', syntax: 'antiforward <kick|warn N|delete|off>', desc: 'Block forwarded messages', target: 'group' },
  fwdpermit: { section: '🛡 ANTI SYSTEM', syntax: 'fwdpermit @user', desc: 'Exempt from AntiForward', target: 'group' },
  rmfwdpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmfwdpermit @user', desc: 'Remove AntiForward exemption', target: 'group' },

  // AntiChannel
  antichannel: { section: '🛡 ANTI SYSTEM', syntax: 'antichannel <kick|warn N|delete|off>', desc: 'Block forwarded channel posts', target: 'group' },
  chanpermit: { section: '🛡 ANTI SYSTEM', syntax: 'chanpermit @user', desc: 'Exempt from AntiChannel', target: 'group' },
  rmchanpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmchanpermit @user', desc: 'Remove AntiChannel exemption', target: 'group' },

  // AntiPromote / AntiDemote
  antipromote: { section: '🛡 ANTI SYSTEM', syntax: 'antipromote <kick|warn N|delete|off>', desc: 'React to unauthorized admin promotions', target: 'group' },
  antidemote: { section: '🛡 ANTI SYSTEM', syntax: 'antidemote <dwp|dnp|kwp|knp|off>', desc: 'React to unauthorized admin demotions', target: 'group' },
  // ── Missing-catalog registrations (kept out of the ◈ OTHER bucket) ──
  allgstatus: { section: '📊 UTILITY', syntax: 'allgstatus [msg]', desc: 'Post to ALL group statuses', target: 'main', navCategory: 'status' },
  mute: { section: '⚔ MODERATION', syntax: 'mute', desc: 'Mute the group', target: 'group' },
  unmute: { section: '⚔ MODERATION', syntax: 'unmute', desc: 'Unmute the group', target: 'group' },
  block: { section: '⚔ MODERATION', syntax: 'block [user]', desc: 'Block a user (reply / mention / number)', target: 'both' },
  deleteall: { section: '⚔ MODERATION', syntax: 'deleteall', desc: 'Delete recent bot messages', target: 'group' },
  stopjoin: { section: '⚔ MODERATION', syntax: 'stopjoin [on|off]', desc: 'Disable automatic join approvals', target: 'group' },
  gmpermit: { section: '🛡 ANTI SYSTEM', syntax: 'gmpermit [user]', desc: 'Permit a user for group mentions', target: 'group' },
  rmgmpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmgmpermit [user]', desc: 'Revoke a group-mention permit', target: 'group' },

  // ── Join Approval ─────────────────────────────────────────
  // Mirror of the Telegram per-group dashboard approval features,
  // now accessible directly from WhatsApp.
  // Join approval remains callable directly on WhatsApp, but these controls
  // are intentionally not rendered in WhatsApp navigation menus. Telegram
  // already provides the guided approval submenu.
  pendingjoin: { section: '📊 UTILITY', syntax: 'pendingjoin', desc: 'List pending join requests', target: 'group', hidden: true },
  approveall: { section: '📊 UTILITY', syntax: 'approveall', desc: 'Approve ALL pending join requests', target: 'group', hidden: true },
  rejectall: { section: '📊 UTILITY', syntax: 'rejectall', desc: 'Reject ALL pending join requests', target: 'group', hidden: true },
  approveamt: { section: '📊 UTILITY', syntax: 'approveamt <n>', desc: 'Approve first N pending requests', target: 'group', hidden: true },
  approvecountry: { section: '📊 UTILITY', syntax: 'approvecountry <+code>', desc: 'Approve requests by phone country code', target: 'group', hidden: true },
};

// ── Section order ─────────────────────────────────────────
// Controls display order. Sections not listed here are appended as "◈ OTHER".
const MAIN_SECTION_ORDER = [
  '◈ STATUS ENGINE',
  '◈ BROADCAST NETWORK',
  '◈ TAG ENGINE',
  '◈ LIFECYCLE',
  '◈ PAIRING',
  '◈ BUCKET',
  '◈ SYSTEM CONFIG',
];

const GROUP_SECTION_ORDER = [
  '◈ GROUP MODERATION',
  '◈ JOIN APPROVAL',
  '◈ TAG ENGINE',
  '◈ ANTI SYSTEM',
];

// ── Builder ───────────────────────────────────────────────

function buildSections(
  prefix: string,
  knownCommands: readonly string[],
  menuTarget: 'main' | 'group',
  sectionOrder: string[]
): { heading: string; items: { cmd: string; desc: string }[] }[] {
  const sectionMap = new Map<string, { cmd: string; desc: string }[]>();

  for (const [, entry] of Object.entries(MENU_CATALOG)) {
    if (entry.hidden) continue;
    const t = entry.target ?? 'main';
    if (t !== menuTarget && t !== 'both') continue;
    const list = sectionMap.get(entry.section) ?? [];
    list.push({ cmd: prefix + entry.syntax, desc: entry.desc });
    sectionMap.set(entry.section, list);
  }

  // Any registered command not in catalog for this menu → "◈ OTHER"
  const catalogued = new Set(Object.keys(MENU_CATALOG));
  const uncategorised: { cmd: string; desc: string }[] = [];
  for (const cmd of knownCommands) {
    if (!catalogued.has(cmd)) {
      uncategorised.push({ cmd: prefix + cmd, desc: '—' });
    }
  }
  if (uncategorised.length > 0) {
    sectionMap.set('◈ OTHER', uncategorised);
  }

  const ordered: { heading: string; items: { cmd: string; desc: string }[] }[] = [];
  for (const heading of sectionOrder) {
    const items = sectionMap.get(heading);
    if (items?.length) ordered.push({ heading, items });
    sectionMap.delete(heading);
  }
  for (const [heading, items] of sectionMap) {
    if (items.length) ordered.push({ heading, items });
  }
  return ordered;
}

/**
 * Build main menu sections (.menu / .help).
 * Shows global/broadcast/lifecycle/system commands.
 * Any command in knownCommands missing from the catalog falls into "◈ OTHER".
 */
export function buildMenuSections(
  prefix: string,
  knownCommands: readonly string[] = []
): { heading: string; items: { cmd: string; desc: string }[] }[] {
  return buildSections(prefix, knownCommands, 'main', MAIN_SECTION_ORDER);
}

/**
 * Build group menu sections (.gmenu).
 * Shows group moderation + anti system commands.
 * Every new group command added to MENU_CATALOG with target:'group' appears here automatically.
 */
export function buildGroupMenuSections(
  prefix: string,
  knownCommands: readonly string[] = []
): { heading: string; items: { cmd: string; desc: string }[] }[] {
  return buildSections(prefix, knownCommands, 'group', GROUP_SECTION_ORDER);
}

// ═══════════════════════════════════════════════════════════
// MENU NAVIGATION HUB — button-driven, registry-powered
//
// The main menu is a navigation hub. Each category maps to an
// explicit command list (derived from MENU_CATALOG / ALL_COMMANDS)
// and is rendered as a native WhatsApp quick_reply button. Tapping
// a button opens ONLY that category — never the whole registry.
// Category pages are paginated (5-7 commands each) with native
// Prev / Next / Home buttons.
// ═══════════════════════════════════════════════════════════

// Kept as an internal compatibility constant for older imports. WhatsApp
// category rendering no longer uses pagination.
export const MENU_PAGE_SIZE = 6;

/** Commands that require the premium tier — flagged 💎 in help pages. */
const PREMIUM_COMMANDS = new Set<string>([
  'joinall', 'leaveall', 'allstatus', 'allstatusx', 'allchat',
  'sstatus', 'spam', 'togstatusx', 'tochatx', 'setmenuvideo',
]);

export interface NavCategory {
  id: string;
  label: string;
  emoji: string;
  desc: string;
  /** Command names in this category (keys of MENU_CATALOG / ALL_COMMANDS). */
  commands: string[];
  /** Absorb registered-but-uncatalogued commands. */
  fallback?: boolean;
  /**
   * Show commands regardless of the menu target. The main-menu hub exposes
   * Group / Promotion / Anti-System (which are group-targeted) so the hub
   * counts and the category pages never render empty.
   */
  showAll?: boolean;
}

const GROUP_MODERATION_COMMANDS = [
  'gmenu', 'kick', 'remove', 'ban', 'unban', 'banlist', 'promote', 'demote', 'dnkick',
  'warn', 'unwarn', 'resetwarn', 'warns', 'block', 'deleteall', 'poll',
  'mute', 'unmute', 'blockall', 'autoblock', 'stopjoin', 'setwelcome',
  'welcomemsg', 'welcome', 'setgoodbye', 'goodbyemsg', 'goodbye', 'kickmsg',
  'warnmsg', 'banmsg', 'unbanmsg', 'eventstatus',
];

/** Group actions that should carry the compact WhatsApp admin badge. */
const GROUP_ADMIN_COMMANDS = new Set([
  'kick', 'remove', 'ban', 'promote', 'demote', 'dnkick', 'warn', 'unwarn',
  'resetwarn', 'block', 'deleteall', 'mute', 'unmute', 'blockall', 'autoblock',
  'stopjoin',
]);

const ANTI_COMMANDS = [
  'antistatus', 'antilink', 'linkpermit', 'rmlinkpermit', 'antilinkmsg',
  'antibot', 'botpermit', 'rmbotpermit', 'antispam', 'spamlimit',
  'spampermit', 'rmspampermit', 'antispammsg', 'antipic', 'antivid',
  'antiaud', 'picpermit', 'rmpicpermit', 'vidpermit', 'rmvidpermit',
  'audpermit', 'rmaudpermit', 'antivn', 'vnpermit', 'rmvnpermit',
  'antivnmsg', 'antitxt', 'antiemoji', 'emojipermit', 'rmemojipermit',
  'antiemojimsg', 'antisticker', 'sticpermit', 'rmsticpermit',
  'antigroupcall', 'antinsfw', 'nsfwpermit', 'rmnsfwpermit',
  'antigroupmention', 'antigm', 'mentionpermit', 'rmmentionpermit',
  'antiwords', 'antiaddword', 'antirmword', 'antiwordlist', 'antiwordsmsg',
  'antipoll', 'pollpermit', 'rmpollpermit', 'antiforward', 'fwdpermit',
  'rmfwdpermit', 'antichannel', 'chanpermit', 'rmchanpermit',
  'antipromote', 'antidemote', 'antigstatus',
  'setantiwords', 'rmantiwords', 'clearantiwords',
];

const GROUP_COMMAND_ORDER = new Map(GROUP_MODERATION_COMMANDS.map((name, index) => [name, index]));
const ANTI_COMMAND_ORDER = new Map(ANTI_COMMANDS.map((name, index) => [name, index]));

// The hub stays compact, while every category page is complete for its
// domain. Status commands intentionally span the status poster, broadcast,
// personal-status, recovery, and automation engines.
const UTILITY_NAV_COMMANDS = [
  'tag', 'mtag', 'join', 'left', 'leave', 'joinall', 'leaveall', 'addlink',
  'sticker', 'setpackname', 'setauthor', 'setcmd', 'delcmd', 'listcmd',
  'setmenupic', 'setmenuvideo', 'delmenumedia',
];

const MESSAGING_NAV_COMMANDS = ['tochat', 'tochatx', 'allchat'];
const SESSION_NAV_COMMANDS = [
  'ls', 'curr', 'switch', 'sinfo', 'restart', 'disconnect', 'delete',
  'rename', 'freeze', 'unfreeze',
];
const CONFIGURATION_NAV_COMMANDS = [
  'setprefix', 'prefix', 'public', 'setmode', 'publicresponse', 'tagreply',
  'swresponse', 'settimezone', 'setsudo', 'delsudo', 'sudo',
  'setpfp', 'getpfp', 'removepfp', 'setname', 'setbio', 'wainfo', 'creategc',
  'collect', 'autopromo', 'menu', 'help', 'gmenu',
];

// Four WhatsApp-native dashboard domains. The command arrays are intentionally
// empty: command membership is resolved from MENU_CATALOG + the live parser
// registry below, so counts cannot drift when commands are added or removed.
export const MAIN_NAV: NavCategory[] = [
  { id: 'group', label: 'Group', emoji: '⚔️', desc: 'Moderation, polls & events', commands: [], showAll: true },
  { id: 'status', label: 'Status', emoji: '📲', desc: 'Auto-view, broadcast & sync', commands: [], showAll: true },
  { id: 'game', label: 'Game', emoji: '🎮', desc: 'Multiplayer chains & trivia', commands: [], showAll: true },
  { id: 'extras', label: 'Extras', emoji: '🧰', desc: 'Anti-system, tools & info', commands: [], showAll: true },
];

// Keep a separate target alias for callers that intentionally render a group
// command context. The dashboard itself remains the same four routes.
export const GROUP_NAV: NavCategory[] = MAIN_NAV;

export function navFor(_menuTarget: 'main' | 'group'): NavCategory[] {
  return MAIN_NAV;
}

export function navCategoryById(menuTarget: 'main' | 'group', id: string): NavCategory | undefined {
  return navFor(menuTarget).find((n) => n.id === id);
}

export interface NavCommandLine {
  /** Raw command name (registry key, e.g. "kick") — used for routing ids. */
  name: string;
  /** Prefixed display form (e.g. ".kick"). */
  cmd: string;
  desc: string;
  section?: string;
  usage?: string;
  permissions?: string;
  premium?: boolean;
}

function entryMatchesTarget(entry: MenuEntry, menuTarget: 'main' | 'group'): boolean {
  const t = entry.target ?? 'main';
  return menuTarget === 'group' ? t === 'group' || t === 'both' : t === 'main' || t === 'both';
}

/** Resolve a nav category's command lines (catalog-driven, fallback-safe). */
const PROMOTION_COMMANDS = new Set(['promote', 'demote', 'antipromote', 'antidemote']);
/**
 * Resolve the registry-owned command names for a hub category. The compact
 * categories use catalog metadata rather than a second hardcoded count list;
 * adding a registered command to the appropriate target/section updates the
 * count and category page automatically.
 */
function dashboardCategoryForCommand(command: string, entry?: MenuEntry): NavCategory['id'] {
  if (entry?.section.includes('GAMES')) return 'game';
  if (entry?.navCategory === 'status') return 'status';
  // Broadcast commands historically lived in the status engine even when
  // their old section label was MODERATION.
  if (/^(?:tochat|tochatx|togstatus|togstatusx|allchat|allstatus|allgstatus|allstatusx|spam|stopspam|stop)$/u.test(command)) return 'status';
  // The Group dashboard is the complete Group & Anti surface. Keep all
  // group-targeted anti modules together instead of hiding them in Extras.
  if (entry?.target === 'group' || entry?.section.includes('MODERATION') || entry?.section.includes('ANTI') || command === 'gmenu') return 'group';
  return 'extras';
}

/** Resolve every live, visible command into one of the four dashboard routes. */
function registeredCommandsForNav(
  nav: NavCategory,
  _menuTarget: 'main' | 'group',
  knownCommands: readonly string[] = []
): string[] {
  const registered = knownCommands.length > 0 ? knownCommands : Object.keys(MENU_CATALOG);
  return registered.filter((name) => {
    const entry = MENU_CATALOG[name];
    if (entry?.hidden) return false;
    return dashboardCategoryForCommand(name, entry) === nav.id;
  });
}

export function navCommandLines(
  prefix: string,
  nav: NavCategory,
  menuTarget: 'main' | 'group',
  knownCommands: readonly string[]
): NavCommandLine[] {
  const lines: NavCommandLine[] = [];
  const commandNames = registeredCommandsForNav(nav, menuTarget, knownCommands);
  const orderedCommandNames = nav.id === 'group'
    ? [...commandNames].sort((a, b) => {
      const aOrder = GROUP_COMMAND_ORDER.has(a) ? GROUP_COMMAND_ORDER.get(a)! : 10_000 + (ANTI_COMMAND_ORDER.get(a) ?? 10_000);
      const bOrder = GROUP_COMMAND_ORDER.has(b) ? GROUP_COMMAND_ORDER.get(b)! : 10_000 + (ANTI_COMMAND_ORDER.get(b) ?? 10_000);
      return aOrder - bOrder;
    })
    : commandNames;
  for (const cmdName of orderedCommandNames) {
    const entry = MENU_CATALOG[cmdName];
    if (entry?.hidden) continue;
    // The command parser is authoritative when supplied. This keeps category
    // counts and pages synchronized as commands are added or removed.
    if (knownCommands.length > 0 && !knownCommands.includes(cmdName)) continue;
    // Dashboard categories are deliberately complete: Group remains useful
    // from a DM and Status/Game commands remain discoverable in group chats.
    // The registry target still guards genuinely scoped category entries when
    // a future category opts out of showAll.
    if (entry && !nav.showAll && !entryMatchesTarget(entry, menuTarget)) continue;
    if (!entry && knownCommands.length === 0) continue;
    lines.push({
      name: cmdName,
      cmd: prefix + (entry?.syntax ?? cmdName),
      desc: entry?.desc ?? '—',
      section: entry?.section,
      usage: entry?.usage,
      permissions: entry?.permissions,
      premium: PREMIUM_COMMANDS.has(cmdName),
    });
  }
  return lines;
}

function clampPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(page, 1), totalPages);
}

export interface NavHubOptions {
  /** Session response mode: 'txt' | 'table' */
  responseMode?: 'txt' | 'table';
  /** Session timezone (IANA). Falls back to server local time. */
  timezone?: string;
  /** Session status: ONLINE / FROZEN / PAIRING … */
  status?: string;
  /** The command sender's pushName / display name. */
  userName?: string;
  /** Pairing timestamp used for the dashboard sync age. */
  pairedAt?: number;
}

/** Format a timestamp in the session timezone (falls back to server time). */
export function formatInTimezone(
  timezone: string | undefined,
  date: Date = new Date()
): { date: string; time: string; timezone: string } {
  const tz = timezone && timezone.trim() ? timezone.trim() : undefined;
  try {
    const fmtDate = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      day: '2-digit', month: 'short', year: 'numeric',
    }).format(date);
    const fmtTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    }).format(date);
    const tzLabel = tz ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { date: fmtDate, time: fmtTime, timezone: tzLabel };
  } catch {
    return {
      date: date.toLocaleDateString('en-GB'),
      time: date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
}

/**
 * OMEGA NAVIGATION hub — compact category dashboard, WhatsApp-mobile width.
 * Header + Status/Prefix line, then one ✦ category row per nav entry with a
 * live command count (computed from the registry) and the category tagline.
 * Pair is special-cased to its own instruction + example block (no count).
 * The footer carries the premium line + the OMEGA • V1 brand line.
 */
export function renderNavHub(
  prefix: string,
  menuTarget: 'main' | 'group',
  knownCommands: readonly string[],
  opts: NavHubOptions = {}
): string {
  const safePrefix = prefix && prefix.trim() ? prefix.trim() : 'None';
  const now = formatInTimezone(opts.timezone);
  const user = opts.userName?.trim() || 'Operator';
  const pairedDays = opts.pairedAt && Number.isFinite(opts.pairedAt)
    ? Math.max(0, Math.floor((Date.now() - opts.pairedAt) / 86_400_000))
    : 0;
  const lines: string[] = [
    '╭─── ⟡ 𝗢𝗠𝗘𝗚𝗔-𝗩𝟭 𝗠𝗘𝗡𝗨 ⟡ ───╮',
    '',
    '[⚡] 𝗤𝗨𝗜𝗖𝗞 𝗔𝗖𝗧𝗜𝗢𝗡𝗦:',
    '▸ Use `help <cmd>` to inspect it',
    `▸ Use \`${safePrefix}pair <number>\` to link`,
    `  └ Ex: ${safePrefix}pair 2348000000000`,
    '',
    '[⚙️] 𝗦𝗬𝗦𝗧𝗘𝗠 𝗗𝗔𝗧𝗔:',
    `▸ User: @${user.replace(/^@/u, '')}`,
    `▸ Time: ${now.time} • ${now.date}`,
    `▸ Sync: ${pairedDays} Days Paired`,
    `▸ Core: 𝗢𝗻𝗹𝗶𝗻𝗲 🟢 | Pfx: ${safePrefix === 'None' ? '𝗡𝗼𝗻𝗲' : safePrefix}`,
    '',
    '[📑] 𝗠𝗘𝗡𝗨 𝗥𝗢𝗨𝗧𝗘𝗦:',
  ];
  for (const nav of navFor(menuTarget)) {
    const count = navCommandLines(prefix, nav, menuTarget, knownCommands).length;
    lines.push(`✦ ${nav.emoji} ${nav.label} ── [${count}]`);
    lines.push(`  └ ${nav.desc}`);
  }
  lines.push('', '╰── 💎 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗘𝗻𝗮𝗯𝗹𝗲𝗱 ──╯');
  return lines.join('\n');
}

const BOLD_LOWER = '𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇';
const BOLD_UPPER = '𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭';
const BOLD_DIGITS = '𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵';
const COMMAND_ITALIC_LOWER = '𝘢𝘣𝘤𝘥𝘦𝘧𝘨𝘩𝘪𝘫𝘬𝘭𝘮𝘯𝘰𝘱𝘲𝘳𝘴𝘵𝘶𝘷𝘸𝘹𝘺𝘻';

function boldMenuText(value: string): string {
  return [...value].map((char) => {
    const lower = char.toLowerCase();
    const lowerIndex = 'abcdefghijklmnopqrstuvwxyz'.indexOf(lower);
    if (lowerIndex >= 0) {
      const map = char === char.toUpperCase() ? BOLD_UPPER : BOLD_LOWER;
      return [...map][lowerIndex] ?? char;
    }
    const digitIndex = '0123456789'.indexOf(char);
    return digitIndex >= 0 ? [...BOLD_DIGITS][digitIndex] ?? char : char;
  }).join('');
}

function compactMenuCommand(command: string, prefix: string): string {
  const withoutPrefix = prefix && command.startsWith(prefix)
    ? command.slice(prefix.length)
    : command;
  // Keep arguments readable; only the command token uses the compact bold font.
  const match = withoutPrefix.match(/^(\S+)([\s\S]*)$/u);
  if (!match) return boldMenuText(withoutPrefix);
  return `${boldMenuText(match[1]!)}${match[2] ?? ''}`;
}

const COMPACT_CATEGORY_DESCRIPTIONS: Record<string, string> = {};

/** Render one complete category response. WhatsApp navigation is not paginated. */
export function renderNavCategoryPage(
  prefix: string,
  navId: string,
  page: number,
  menuTarget: 'main' | 'group',
  knownCommands: readonly string[]
): { text: string; totalPages: number } {
  const nav = navCategoryById(menuTarget, navId);
  if (!nav) return { text: '', totalPages: 0 };
  const lines = navCommandLines(prefix, nav, menuTarget, knownCommands);
  if (lines.length === 0) return { text: '', totalPages: 0 };
  // Category navigation intentionally sends one complete response. Keep the
  // page argument for source compatibility with older callback ids.
  const totalPages = 1;
  const p = 1;
  const categoryHeading = (line: NavCommandLine): string => {
    if (navId === 'status') return line.name.startsWith('vv') || line.name === 'autovv' || line.name === 'antidelete' || line.name === 'sstatus'
      ? '[🛡️] 𝗥𝗘𝗖𝗢𝗩𝗘𝗥𝗬 & 𝗔𝗨𝗧𝗢𝗠𝗔𝗧𝗜𝗢𝗡'
      : '[📲] 𝗦𝗧𝗔𝗧𝗨𝗦 & 𝗕𝗥𝗢𝗔𝗗𝗖𝗔𝗦𝗧';
    if (navId === 'group') return line.section?.includes('ANTI') ? '[🛡️] 𝗔𝗡𝗧𝗜-𝗦𝗬𝗦𝗧𝗘𝗠' : '[⚔️] 𝗚𝗥𝗢𝗨𝗣 𝗠𝗢𝗗𝗘𝗥𝗔𝗧𝗜𝗢𝗡';
    if (navId === 'game') return '[🎮] 𝗠𝗨𝗟𝗧𝗜𝗣𝗟𝗔𝗬𝗘𝗥 & 𝗧𝗥𝗜𝗩𝗜𝗔';
    return line.section?.includes('ANTI') ? '[🛡️] 𝗔𝗡𝗧𝗜-𝗦𝗬𝗦𝗧𝗘𝗠' : '[🧰] 𝗧𝗢𝗢𝗟𝗦 & 𝗜𝗡𝗙𝗢';
  };
  const groups = new Map<string, NavCommandLine[]>();
  for (const line of lines) {
    const heading = categoryHeading(line);
    const group = groups.get(heading) ?? [];
    group.push(line);
    groups.set(heading, group);
  }
  const body: string[] = [];
  for (const [heading, group] of groups) {
    if (body.length) body.push('');
    body.push(heading, '');
    for (const line of group) {
      const adminBadge = navId === 'group' && GROUP_ADMIN_COMMANDS.has(line.name) ? '  [👑 Admin]' : '';
      const command = compactMenuCommand(line.cmd, prefix) + adminBadge + (line.premium ? ' 💎' : '');
      const description = COMPACT_CATEGORY_DESCRIPTIONS[line.name] ?? line.desc;
      const permission = navId !== 'group' && line.permissions ? `• Perm: ${line.permissions}` : '';
      body.push(`✦ ${command}`, `  └─ ${description}`);
      if (permission) body.push(`  ${permission}`);
      body.push('');
    }
  }
  const text = [
    `╭─── ⟡ 𝗢𝗠𝗘𝗚𝗔 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦 ⟡ ───╮`,
    '',
    `${nav.emoji} ${boldMenuText(nav.label.toUpperCase())}:`,
    '',
    ...body,
    '╰── ────────────────── ──╯',
    '· · ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ——— · ·',
  ].join('\n');
  return { text, totalPages };
}

/** Flat, catalog-ordered help lines for the given menu target. */
export function allHelpLines(
  prefix: string,
  menuTarget: HelpTarget,
  knownCommands: readonly string[]
): NavCommandLine[] {
  const out: NavCommandLine[] = [];
  for (const [cmdName, entry] of Object.entries(MENU_CATALOG)) {
    if (entry.hidden) continue;
    if (knownCommands.length > 0 && !knownCommands.includes(cmdName)) continue;
    if (menuTarget !== 'all' && !entryMatchesTarget(entry, menuTarget)) continue;
    out.push({
      name: cmdName,
      cmd: prefix + entry.syntax,
      desc: entry.desc,
      section: entry.section,
      usage: entry.usage,
      permissions: entry.permissions,
      premium: PREMIUM_COMMANDS.has(cmdName),
    });
  }
  const catalogued = new Set(Object.keys(MENU_CATALOG));
  for (const cmd of knownCommands) {
    if (!catalogued.has(cmd)) {
      out.push({ name: cmd, cmd: prefix + cmd, desc: '—', premium: PREMIUM_COMMANDS.has(cmd) });
    }
  }
  return out;
}

/** Text-only help pagination with a stable public category order. */
type HelpTarget = 'main' | 'group' | 'all';

interface HelpCategoryDefinition {
  title: string;
  commands: string[];
}

const HELP_CATEGORY_DEFINITIONS: HelpCategoryDefinition[] = [
  { title: 'Status Tools', commands: ['godcast', 'statusdesign', 'settheme', 'smedia', 'gstatus', 'pstatus', 'allstatus', 'allstatusx'] },
  { title: 'Messaging', commands: ['tochat', 'togstatus', 'tochatx', 'togstatusx', 'allchat', 'stopspam', 'stop'] },
  { title: 'Privacy', commands: ['vv', 'vvdm', 'autovv', 'sstatus', 'antidelete'] },
  { title: 'Automation', commands: ['autosend', 'autodstatus', 'autostatusreact', 'antigstatus'] },
  { title: 'Groups', commands: ['tag', 'mtag', 'join', 'left', 'leave', 'joinall', 'leaveall'] },
  { title: 'Sessions', commands: ['ls', 'curr', 'switch', 'sinfo', 'restart', 'disconnect', 'delete', 'rename', 'freeze', 'unfreeze', 'pair'] },
  { title: 'Stickers & Menu', commands: ['sticker', 'setpackname', 'setauthor', 'setcmd', 'delcmd', 'listcmd', 'setmenupic', 'setmenuvideo'] },
  { title: 'Games', commands: ['wcg', 'ttt', 'tictactoe', 'wyr', 'quiz'] },
  { title: 'Misc', commands: ['addlink', 'setprefix', 'prefix'] },
  { title: 'Moderation', commands: [] },
  { title: 'Anti-System', commands: [] },
  { title: 'Configuration & Info', commands: [] },
  { title: 'Join Approval', commands: ['pendingjoin', 'approveall', 'rejectall', 'approveamt', 'approvecountry'] },
  { title: 'Other', commands: [] },
];

function helpCategoryEntries(prefix: string, menuTarget: HelpTarget, knownCommands: readonly string[]): NavCommandLine[][] {
  const lines = allHelpLines(prefix, menuTarget, knownCommands);
  const byName = new Map(lines.map((line) => [line.name, line]));
  const used = new Set<string>();
  const categories: NavCommandLine[][] = [];
  for (const category of HELP_CATEGORY_DEFINITIONS) {
    let entries = category.commands.map((name) => byName.get(name)).filter((line): line is NavCommandLine => Boolean(line));
    if (category.commands.length === 0) {
      const section = category.title === 'Moderation' ? '⚔ MODERATION'
        : category.title === 'Anti-System' ? '🛡 ANTI SYSTEM'
          : category.title === 'Configuration & Info' ? '⚙ CONFIGURATION' : '';
      entries = lines.filter((line) => !used.has(line.name) && section && MENU_CATALOG[line.name]?.section === section);
    }
    if (category.title === 'Other') entries = lines.filter((line) => !used.has(line.name));
    const unique = entries.filter((line, index, all) => all.findIndex((item) => item.name === line.name) === index);
    unique.forEach((line) => used.add(line.name));
    categories.push(unique);
  }
  return categories;
}

function helpFooter(prefix: string, page: number, totalPages: number): string[] {
  if (page < totalPages) {
    const next = `${prefix}help ${page + 1}`;
    return [
      '· · ────────────────────── · ·',
      `Next: ${next}`,
      `Send ${next} to continue.`,
      '· · ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ——— · ·',
    ];
  }
  return [
    '· · ────────────────────── · ·',
    'Last help page.',
    '· · ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ——— · ·',
  ];
}

export function helpPageText(
  prefix: string,
  page: number,
  menuTarget: HelpTarget,
  knownCommands: readonly string[]
): { text: string; totalPages: number } {
  const categories = helpCategoryEntries(prefix, menuTarget, knownCommands);
  // Page 1 intentionally mirrors the requested guide: Status Tools through
  // Games all remain together (AI games included). Split the larger registry
  // remainder into three readable pages without breaking the order of commands.
  const firstPage = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((index) => categories[index] ?? []);
  const remaining = [8, 9, 10, 11, 12, 13].flatMap((index) => categories[index] ?? []);
  const blockLength = (line: NavCommandLine): number =>
    `✦ ${compactMenuCommand(line.cmd, prefix)}${line.premium ? ' 💎' : ''}\n  └─ ${line.desc}`.length + 2;
  const remainingPages: NavCommandLine[][] = [[], [], []];
  let cursor = 0;
  for (let bucket = 0; bucket < remainingPages.length; bucket++) {
    const bucketsLeft = remainingPages.length - bucket;
    const remainingLength = remaining.slice(cursor).reduce((sum, line) => sum + blockLength(line), 0);
    const targetLength = Math.ceil(remainingLength / bucketsLeft);
    let bucketLength = 0;
    while (cursor < remaining.length) {
      const nextLength = bucketLength + blockLength(remaining[cursor]!);
      if (bucketLength > 0 && nextLength > targetLength && bucketsLeft > 1) break;
      remainingPages[bucket]!.push(remaining[cursor]!);
      cursor++;
      bucketLength = nextLength;
    }
  }
  const pages = [firstPage, ...remainingPages];
  // Preserve the public four-page contract even for a filtered catalog.
  for (let i = 0; i < pages.length; i++) {
    if (pages[i]!.length === 0 && pages.flat().length > 0) {
      pages[i]!.push(pages.flat()[Math.min(i, pages.flat().length - 1)]!);
    }
  }
  const totalPages = 4;
  const p = clampPage(page, totalPages);
  const entries = pages[p - 1] ?? [];
  const header = `📖 ${[...boldMenuText('HELP')].join(' ')}  𝄜  ${[...boldMenuText(String(p))].join(' ')} / ${[...boldMenuText(String(totalPages))].join(' ')}`;
  const body = entries.map((line) => [
    `✦ ${compactMenuCommand(line.cmd, prefix)}${line.premium ? ' 💎' : ''}`,
    `  └─ ${line.desc}`,
  ].join('\n')).join('\n\n');
  return {
    text: [header, '', body, '', ...helpFooter(prefix, p, totalPages)].join('\n'),
    totalPages,
  };
}

// ── Native flow quick_reply button builders ────────────────
// Verified against @crysnovax/baileys 2.7.0: a `nativeFlow` content
// key with `quick_reply` buttons becomes an interactiveMessage with
// body + nativeFlowMessage. Presses arrive as
// interactiveResponseMessage.nativeFlowResponseMessage.paramsJson.

const quickReply = (displayText: string, id: string): { name: string; buttonParamsJson: string } => ({
  name: 'quick_reply',
  buttonParamsJson: JSON.stringify({ display_text: displayText, id }),
});

const targetTag = (menuTarget: 'main' | 'group'): string => (menuTarget === 'group' ? 'g' : 'm');

export function navHubButtons(menuTarget: 'main' | 'group'): { name: string; buttonParamsJson: string }[] {
  const t = targetTag(menuTarget);
  return navFor(menuTarget).map((n) => quickReply(`${n.emoji} ${n.label}`, `menu:cat:${t}:${n.id}`));
}

export function categoryPageButtons(
  menuTarget: 'main' | 'group',
  navId: string,
  page: number,
  totalPages: number
): { name: string; buttonParamsJson: string }[] {
  const t = targetTag(menuTarget);
  const buttons: { name: string; buttonParamsJson: string }[] = [];
  // Category pages are complete responses; only offer a single return route.
  buttons.push(quickReply('🏠 Menu', `menu:home:${t}`));
  return buttons;
}

export function helpPageButtons(
  menuTarget: 'main' | 'group',
  page: number,
  totalPages: number
): { name: string; buttonParamsJson: string }[] {
  const t = targetTag(menuTarget);
  const buttons: { name: string; buttonParamsJson: string }[] = [];
  if (page > 1) buttons.push(quickReply('⬅️ Prev', `menu:help:${t}:${page - 1}`));
  if (page < totalPages) buttons.push(quickReply('Next ➡️', `menu:help:${t}:${page + 1}`));
  buttons.push(quickReply('🏠 Menu', `menu:home:${t}`));
  return buttons;
}

// ═══════════════════════════════════════════════════════════
// NATIVE INTERACTIVE SHEET (single_select native-flow)
//
// The interactive "table" — a single_select native-flow button
// opening a bottom sheet with selectable rows. Every row carries a
// routing id consumed by the Central Interaction Router:
//   menu:*     → navigation
//   cmd:*      → command help card
//   run:ping   → executes ping
// =══════════════════════════════════════════════════════════

/**
 * The category page's command sheet: 6 commands + Prev/Menu/Next rows.
 * Returns totalPages 0 for unknown/empty categories (caller falls back).
 */
export function categorySheet(
  prefix: string,
  menuTarget: 'main' | 'group',
  navId: string,
  page: number,
  knownCommands: readonly string[]
): { title: string; sections: NativeListSection[]; totalPages: number } {
  const nav = navCategoryById(menuTarget, navId);
  if (!nav) return { title: 'Menu', sections: [], totalPages: 0 };
  const lines = navCommandLines(prefix, nav, menuTarget, knownCommands);
  if (lines.length === 0) return { title: 'Menu', sections: [], totalPages: 0 };

  // Category navigation is one response, not a page sequence. The list sheet
  // remains available as a convenience on clients that support it, but it
  // contains the complete registered category and only a Home row.
  const totalPages = 1;
  const p = 1;
  const t = targetTag(menuTarget);

  const rows: NativeListRow[] = lines.map((l) => {
    const meta: string[] = [];
    if (l.usage) meta.push(l.usage);
    if (l.permissions) meta.push(`Perm: ${l.permissions}`);
    return {
      title: `${l.cmd}${l.premium ? ' 💎' : ''}`,
      description: [l.desc, ...meta].filter(Boolean).join(' • '),
      rowId: l.name === 'ping' ? 'run:ping' : `cmd:${t}:${navId}:${l.name}`,
    };
  });

  const navRows: NativeListRow[] = [];
  navRows.push({ title: '🏠 Menu', rowId: `menu:home:${t}` });

  return {
    title: `${nav.emoji} ${nav.label} — ${p}/${totalPages}`,
    sections: [
      { title: 'Commands', rows },
      { title: 'Navigation', rows: navRows },
    ],
    totalPages,
  };
}

/**
 * The category page's native single_select button ("table" opener).
 * Combines the command sheet with the visible Prev/Next/Home buttons.
 */
export function categorySheetButton(
  prefix: string,
  menuTarget: 'main' | 'group',
  navId: string,
  page: number,
  knownCommands: readonly string[]
): {
  buttons: { name: string; buttonParamsJson: string }[];
  totalPages: number;
} {
  const sheet = categorySheet(prefix, menuTarget, navId, page, knownCommands);
  if (sheet.totalPages === 0) return { buttons: [], totalPages: 0 };
  const t = targetTag(menuTarget);
  const buttons = [singleSelectButton(`📂 ${sheet.title}`, sheet.sections)];
  buttons.push(quickReply('🏠 Menu', `menu:home:${t}`));
  return { buttons, totalPages: sheet.totalPages };
}

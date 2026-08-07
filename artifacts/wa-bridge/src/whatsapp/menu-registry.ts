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

import { getPremiumTip } from '../utils/ascii-art.js';
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
  /** Which menu this entry appears in: 'main' | 'group' | 'both' */
  target?: 'main' | 'group' | 'both';
  /** If true, the command is never shown in any menu */
  hidden?: boolean;
}

/** Full catalog — maps command name → menu entry */
export const MENU_CATALOG: Record<string, MenuEntry> = {

  // ── Status Engine ──────────────────────────────────────────
  godcast: { section: '⚔ MODERATION', syntax: 'godcast', desc: 'Post designed status for current group', target: 'main' },
  statusdesign: { section: '⚔ MODERATION', syntax: 'statusdesign', desc: 'Post designed status for current group', target: 'main' },
  settheme: { section: '⚔ MODERATION', syntax: 'settheme [theme]', desc: 'Set default status theme for this group', target: 'main' },
  smedia: { section: '⚔ MODERATION', syntax: 'smedia', desc: 'Post media status', target: 'main' },
  gstatus: { section: '⚔ MODERATION', syntax: 'gstatus [msg]', desc: 'Post text to current group status', target: 'main' },
  tochat: { section: '⚔ MODERATION', syntax: 'tochat [jid] [msg]', desc: 'Send message to a target group', target: 'main' },
  togstatus: { section: '⚔ MODERATION', syntax: 'togstatus [jid] [msg]', desc: 'Post to a target group status', target: 'main' },
  tochatx: { section: '⚔ MODERATION', syntax: 'tochatx [jid] [n] [msg]', desc: 'Repeat a message to a target group', target: 'main' },
  togstatusx: { section: '⚔ MODERATION', syntax: 'togstatusx [n] [jid] [msg]', desc: 'Repeat to a target group status', target: 'main' },
  sstatus: { section: '⚔ MODERATION', syntax: 'sstatus [msg]', desc: 'Run status loop (until stopspam)', target: 'main' },

  // ── Broadcast Network ─────────────────────────────────────
  allstatus: { section: '⚔ MODERATION', syntax: 'allstatus [msg]', desc: 'Post to ALL group statuses', target: 'main' },
  allstatusx: { section: '⚔ MODERATION', syntax: 'allstatusx [n] [msg]', desc: 'Repeat to every group status', target: 'main' },
  allchat: { section: '⚔ MODERATION', syntax: 'allchat [msg]', desc: 'Send to all groups with hidetag', target: 'main' },
  stopspam: { section: '⚔ MODERATION', syntax: 'stopspam', desc: 'Stop the active status / outreach loop', target: 'main' },
  stop: { section: '⚔ MODERATION', syntax: 'stop', desc: 'Alias for stopspam', target: 'main' },

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
  setpackname: { section: '🎨 STICKER ENGINE', syntax: 'setpackname [name]', desc: 'Set sticker pack name', target: 'main' },
  setauthor: { section: '🎨 STICKER ENGINE', syntax: 'setauthor [name]', desc: 'Set sticker author name', target: 'main' },
  setcmd: { section: '🎨 STICKER ENGINE', syntax: 'setcmd [cmd]', desc: 'Bind a quoted sticker to a command', target: 'main' },
  delcmd: { section: '🎨 STICKER ENGINE', syntax: 'delcmd', desc: 'Remove a sticker binding', target: 'main' },
  listcmd: { section: '🎨 STICKER ENGINE', syntax: 'listcmd', desc: 'List all sticker command bindings', target: 'main' },
  setmenupic: { section: '⚙ CONFIGURATION', syntax: 'setmenupic', desc: 'Set replied image as menu media', target: 'main' },
  setmenuvideo: { section: '⚙ CONFIGURATION', syntax: 'setmenuvideo', desc: 'Set replied video as menu media', target: 'main' },
  delmenumedia: { section: '⚙ CONFIGURATION', syntax: 'delmenumedia', desc: 'Restore default text-only menus', target: 'main' },
  setsudo: { section: '⚙ CONFIGURATION', syntax: 'setsudo [number]', desc: 'Grant command access (or reply to msg)', target: 'main' },
  delsudo: { section: '⚙ CONFIGURATION', syntax: 'delsudo [number]', desc: 'Revoke command access', target: 'main' },
  sudo: { section: '⚙ CONFIGURATION', syntax: 'sudo', desc: 'List all sudo numbers', target: 'main' },
  public: { section: '⚙ CONFIGURATION', syntax: 'public [on|off]', desc: 'Legacy alias for setmode', target: 'main' },
  setmode: { section: '⚙ CONFIGURATION', syntax: 'setmode <public|private>', desc: 'Public = anyone may use commands; Private = authorized only (Pair always works)', target: 'main' },
  swresponse: { section: '⚙ CONFIGURATION', syntax: 'swresponse <txt|table>', desc: 'Switch response rendering mode (text or native table)', target: 'main' },
  settimezone: { section: '⚙ CONFIGURATION', syntax: 'settimezone <IANA>', desc: 'Set session timezone (e.g. Africa/Lagos)', target: 'main' },
  globalsudo: { section: '⚙ CONFIGURATION', syntax: 'globalsudo', desc: 'View Global Sudo (admin only)', target: 'main' },
  setglobalsudo: { section: '⚙ CONFIGURATION', syntax: 'setglobalsudo [num]', desc: 'Grant Global Sudo (applies to every session)', target: 'main' },
  delglobalsudo: { section: '⚙ CONFIGURATION', syntax: 'delglobalsudo [num]', desc: 'Revoke Global Sudo', target: 'main' },
  omni: { section: '⚙ CONFIGURATION', syntax: 'omni', desc: 'View Omni Owner (highest permission)', target: 'main' },
  setomni: { section: '⚙ CONFIGURATION', syntax: 'setomni [num]', desc: 'Grant Omni Owner (bypasses every permission check)', target: 'main' },
  delomni: { section: '⚙ CONFIGURATION', syntax: 'delomni [num]', desc: 'Revoke Omni Owner', target: 'main' },
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
  spam: { section: '⚙ CONFIGURATION', syntax: 'spam', desc: 'Alias for sstatus', target: 'main' },
  menu: { section: '⚙ CONFIGURATION', syntax: 'menu', desc: 'Show general command menu', target: 'main',
    usage: 'Show the main command menu.',
    permissions: 'Public',
    examples: ['menu'],
    output: 'Premium OS-style menu.' },
  help: { section: '⚙ CONFIGURATION', syntax: 'help', desc: 'Alias for menu', target: 'main' },
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
  antitxt: { section: '🛡 ANTI SYSTEM', syntax: 'antitxt <kick|warn N|delete|off>', desc: 'Block plain text messages', target: 'group' },

  // AntiEmoji
  antiemoji: { section: '🛡 ANTI SYSTEM', syntax: 'antiemoji <kick|warn N|delete|off>', desc: 'Block emoji messages', target: 'group' },
  emojipermit: { section: '🛡 ANTI SYSTEM', syntax: 'emojipermit @user', desc: 'Exempt from AntiEmoji', target: 'group' },
  rmemojipermit:{ section: '◈ ANTI SYSTEM',      syntax: 'rmemojipermit @user',       desc: 'Remove AntiEmoji exemption',                 target: 'group' },
  antiemojimsg: { section: '🛡 ANTI SYSTEM', syntax: 'antiemojimsg [text]', desc: 'Custom AntiEmoji message', target: 'group' },

  // AntiSticker
  antisticker: { section: '🛡 ANTI SYSTEM', syntax: 'antisticker <kick|warn N|delete|off>', desc: 'Block sticker messages', target: 'group' },
  sticpermit: { section: '🛡 ANTI SYSTEM', syntax: 'sticpermit @user', desc: 'Exempt from AntiSticker', target: 'group' },
  rmsticpermit: { section: '🛡 ANTI SYSTEM', syntax: 'rmsticpermit @user', desc: 'Remove AntiSticker exemption', target: 'group' },

  // AntiGroupCall
  antigroupcall:{ section: '◈ ANTI SYSTEM',      syntax: 'antigroupcall <kick|warn N|delete|off>', desc: 'Block group calls',           target: 'group' },

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
  antiwords: { section: '🛡 ANTI SYSTEM', syntax: 'antiwords <kick|warn N|delete|off>', desc: 'Block messages with blocked words', target: 'group' },
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

  // ── Join Approval ─────────────────────────────────────────
  // Mirror of the Telegram per-group dashboard approval features,
  // now accessible directly from WhatsApp.
  pendingjoin: { section: '📊 UTILITY', syntax: 'pendingjoin', desc: 'List pending join requests', target: 'group' },
  approveall: { section: '📊 UTILITY', syntax: 'approveall', desc: 'Approve ALL pending join requests', target: 'group' },
  rejectall: { section: '📊 UTILITY', syntax: 'rejectall', desc: 'Reject ALL pending join requests', target: 'group' },
  approveamt: { section: '📊 UTILITY', syntax: 'approveamt <n>', desc: 'Approve first N pending requests', target: 'group' },
  approvecountry: { section: '📊 UTILITY', syntax: 'approvecountry <+code>', desc: 'Approve requests by phone country code', target: 'group' },
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
}

const GROUP_MODERATION_COMMANDS = [
  'kick', 'remove', 'dnkick', 'ban', 'unban', 'banlist', 'warn', 'unwarn',
  'resetwarn', 'warns', 'poll', 'blockall', 'autoblock', 'block', 'deleteall',
  'mute', 'unmute', 'stopjoin', 'setwelcome', 'welcomemsg', 'welcome',
  'setgoodbye', 'goodbyemsg', 'goodbye', 'kickmsg', 'warnmsg', 'banmsg',
  'unbanmsg', 'eventstatus', 'pendingjoin', 'approveall', 'rejectall',
  'approveamt', 'approvecountry',
];

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
  'antipromote', 'antidemote',
];

export const MAIN_NAV: NavCategory[] = [
  { id: 'help', label: 'Help', emoji: '📖', desc: 'Navigation & command index', commands: ['menu', 'help', 'gmenu'] },
  { id: 'group', label: 'Group', emoji: '⚔️', desc: 'Kick, ban, warn, polls & events', commands: GROUP_MODERATION_COMMANDS },
  { id: 'promo', label: 'Promotion', emoji: '⬆️', desc: 'Admin promotion, demotion & guards', commands: ['promote', 'demote', 'antipromote', 'antidemote'] },
  { id: 'info', label: 'Info', emoji: 'ℹ️', desc: 'Ping, status, groups & users', commands: ['ping', 'info', 'groups', 'jid', 'userinfo', 'getinfo', 'sudo', 'idea'] },
  { id: 'system', label: 'System', emoji: '🖥️', desc: 'Status engine, broadcast & sessions', commands: ['godcast', 'statusdesign', 'settheme', 'smedia', 'gstatus', 'tochat', 'togstatus', 'tochatx', 'togstatusx', 'sstatus', 'allstatus', 'allstatusx', 'allchat', 'stopspam', 'stop', 'spam', 'join', 'joinall', 'left', 'leave', 'leaveall', 'addlink', 'ls', 'curr', 'switch', 'sinfo', 'restart', 'disconnect', 'delete', 'rename', 'freeze', 'unfreeze'] },
  { id: 'pair', label: 'Pair', emoji: '📱', desc: 'Link a new WhatsApp session', commands: ['pair'] },
  { id: 'settings', label: 'Settings', emoji: '⚙️', desc: 'Prefix, sudo, media & stickers', commands: ['setprefix', 'prefix', 'public', 'publicresponse', 'tagreply', 'setmenupic', 'setmenuvideo', 'delmenumedia', 'setsudo', 'delsudo', 'setpackname', 'setauthor', 'setcmd', 'delcmd', 'listcmd'] },
  { id: 'utils', label: 'Utilities', emoji: '🧰', desc: 'Tag, mtag, stickers & extras', commands: ['tag', 'mtag', 'sticker'], fallback: true },
];

export const GROUP_NAV: NavCategory[] = [
  { id: 'group', label: 'Group', emoji: '⚔️', desc: 'Kick, ban, warn, polls & events', commands: GROUP_MODERATION_COMMANDS },
  { id: 'promo', label: 'Promotion', emoji: '⬆️', desc: 'Admin promotion, demotion & guards', commands: ['promote', 'demote', 'antipromote', 'antidemote'] },
  { id: 'anti', label: 'Anti', emoji: '🛡️', desc: 'Full Anti System — link, spam, media, words', commands: ANTI_COMMANDS },
  { id: 'info', label: 'Info', emoji: 'ℹ️', desc: 'Ping, status, groups & users', commands: ['ping', 'info', 'groups', 'jid', 'userinfo', 'getinfo', 'sudo', 'idea'] },
  { id: 'utils', label: 'Utilities', emoji: '🧰', desc: 'Tag, mtag, stickers & extras', commands: ['tag', 'mtag', 'sticker'], fallback: true },
];

export function navFor(menuTarget: 'main' | 'group'): NavCategory[] {
  return menuTarget === 'group' ? GROUP_NAV : MAIN_NAV;
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
  usage?: string;
  permissions?: string;
  premium?: boolean;
}

function entryMatchesTarget(entry: MenuEntry, menuTarget: 'main' | 'group'): boolean {
  const t = entry.target ?? 'main';
  return menuTarget === 'group' ? t === 'group' || t === 'both' : t === 'main' || t === 'both';
}

/** Resolve a nav category's command lines (catalog-driven, fallback-safe). */
export function navCommandLines(
  prefix: string,
  nav: NavCategory,
  menuTarget: 'main' | 'group',
  knownCommands: readonly string[]
): NavCommandLine[] {
  const lines: NavCommandLine[] = [];
  for (const cmdName of nav.commands) {
    const entry = MENU_CATALOG[cmdName];
    if (entry?.hidden) continue;
    if (entry && !entryMatchesTarget(entry, menuTarget)) continue;
    if (!entry && !knownCommands.includes(cmdName)) continue;
    lines.push({
      name: cmdName,
      cmd: prefix + (entry?.syntax ?? cmdName),
      desc: entry?.desc ?? '—',
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

/** Compact navigation-hub body (no giant borders, WhatsApp-mobile width). */
export function renderNavHub(
  prefix: string,
  menuTarget: 'main' | 'group',
  knownCommands: readonly string[],
  opts: NavHubOptions = {}
): string {
  const safePrefix = prefix && prefix.trim() ? prefix.trim() : '(none)';
  const status = opts.status ?? 'ONLINE';
  const response = opts.responseMode === 'table' ? '📊 TABLE' : '📝 TXT';
  const tz = formatInTimezone(opts.timezone);
  const who = opts.userName ? `▸ user: ${opts.userName}` : '';
  const lines: string[] = [
    '⚜ OMEGA • NAVIGATION ⚜',
    `▸ status: ${status} ▸ prefix: ${safePrefix}`,
    `▸ response: ${response} ▸ tz: ${tz.timezone}`,
    `▸ ${tz.date} • ${tz.time}`,//
    ...(who ? [who] : []),
    '',
  ];
  for (const nav of navFor(menuTarget)) {
    const count = navCommandLines(prefix, nav, menuTarget, knownCommands).length;
    lines.push(`${nav.emoji} ${nav.label} — ${nav.desc} [${count}]`);
  }
  lines.push('');
  lines.push('Tap a button below to open its section.');
  lines.push(`╰─ ${getPremiumTip()}`);
  return lines.join('\n');
}

/** One category page (5-7 commands) with usage + permissions + premium flag. */
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
  const totalPages = Math.max(1, Math.ceil(lines.length / MENU_PAGE_SIZE));
  const p = clampPage(page, totalPages);
  const slice = lines.slice((p - 1) * MENU_PAGE_SIZE, p * MENU_PAGE_SIZE);
  const body = slice.map((l) => {
    const meta: string[] = [];
    if (l.usage) meta.push(`Usage: ${l.usage}`);
    if (l.permissions) meta.push(`Perm: ${l.permissions}`);
    return `${l.cmd}${l.premium ? ' 💎' : ''}\n  ${l.desc}${meta.length > 0 ? `\n  ${meta.join(' • ')}` : ''}`;
  });
  const text = [
    `${nav.emoji} ${nav.label.toUpperCase()} — ${p}/${totalPages}`,
    '─────────────────────',
    ...body,
    '',
    'Use the buttons to navigate.',
  ].join('\n');
  return { text, totalPages };
}

/** Flat, catalog-ordered help lines for the given menu target. */
export function allHelpLines(
  prefix: string,
  menuTarget: 'main' | 'group',
  knownCommands: readonly string[]
): NavCommandLine[] {
  const out: NavCommandLine[] = [];
  for (const [cmdName, entry] of Object.entries(MENU_CATALOG)) {
    if (entry.hidden) continue;
    if (!entryMatchesTarget(entry, menuTarget)) continue;
    out.push({
      name: cmdName,
      cmd: prefix + entry.syntax,
      desc: entry.desc,
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

/** Paginated help page — Help 1/N, 5-7 commands, never truncated. */
export function helpPageText(
  prefix: string,
  page: number,
  menuTarget: 'main' | 'group',
  knownCommands: readonly string[]
): { text: string; totalPages: number } {
  const lines = allHelpLines(prefix, menuTarget, knownCommands);
  if (lines.length === 0) return { text: 'No commands available.', totalPages: 1 };
  const totalPages = Math.max(1, Math.ceil(lines.length / MENU_PAGE_SIZE));
  const p = clampPage(page, totalPages);
  const slice = lines.slice((p - 1) * MENU_PAGE_SIZE, p * MENU_PAGE_SIZE);
  const body = slice.map((l) => {
    const meta: string[] = [];
    if (l.usage) meta.push(`Usage: ${l.usage}`);
    if (l.permissions) meta.push(`Perm: ${l.permissions}`);
    return `${l.cmd}${l.premium ? ' 💎' : ''}\n  ${l.desc}${meta.length > 0 ? `\n  ${meta.join(' • ')}` : ''}`;
  });
  const text = [
    `📖 HELP ${p}/${totalPages}`,
    '─────────────────────',
    ...body,
    '',
    `Reply ${prefix}help <n> or use the buttons.`,
  ].join('\n');
  return { text, totalPages };
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
  if (page > 1) buttons.push(quickReply('⬅️ Prev', `menu:cat:${t}:${navId}:${page - 1}`));
  if (page < totalPages) buttons.push(quickReply('Next ➡️', `menu:cat:${t}:${navId}:${page + 1}`));
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

  const totalPages = Math.max(1, Math.ceil(lines.length / MENU_PAGE_SIZE));
  const p = clampPage(page, totalPages);
  const t = targetTag(menuTarget);
  const slice = lines.slice((p - 1) * MENU_PAGE_SIZE, p * MENU_PAGE_SIZE);

  const rows: NativeListRow[] = slice.map((l) => {
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
  if (p > 1) navRows.push({ title: '⬅️ Prev', rowId: `menu:cat:${t}:${navId}:${p - 1}` });
  navRows.push({ title: '🏠 Menu', rowId: `menu:home:${t}` });
  if (p < totalPages) navRows.push({ title: 'Next ➡️', rowId: `menu:cat:${t}:${navId}:${p + 1}` });

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
  if (page > 1) buttons.push(quickReply('⬅️ Prev', `menu:cat:${t}:${navId}:${page - 1}`));
  if (page < sheet.totalPages) buttons.push(quickReply('Next ➡️', `menu:cat:${t}:${navId}:${page + 1}`));
  buttons.push(quickReply('🏠 Menu', `menu:home:${t}`));
  return { buttons, totalPages: sheet.totalPages };
}

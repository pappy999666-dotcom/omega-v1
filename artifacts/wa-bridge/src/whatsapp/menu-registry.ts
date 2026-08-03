// ============================================================
// WA-Bridge — Menu Registry
//
// Single source of truth for every command's section, syntax,
// description, and which menu it belongs to.
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
  public: { section: '⚙ CONFIGURATION', syntax: 'public [on|off]', desc: 'Enable/disable public command access', target: 'main' },
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
  ban: { section: '⚔ MODERATION', syntax: 'ban', desc: 'Ban a member (kick + block)', target: 'group' },
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
  pollpermit: { section: '🛡 ANTI SYSTEM', syntax: 'pollpermit @user', desc: 'Exempt from AntiPoll', target: 'group' },replace:mit: { section: '🛡 ANTI SYSTEM', syntax: 'rmpollpermit @user', desc: 'Remove AntiPoll exemption', target: 'group' },

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

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
  /** Which menu this entry appears in: 'main' | 'group' | 'both' */
  target?: 'main' | 'group' | 'both';
  /** If true, the command is never shown in any menu */
  hidden?: boolean;
}

/** Full catalog — maps command name → menu entry */
export const MENU_CATALOG: Record<string, MenuEntry> = {

  // ── Status Engine ──────────────────────────────────────────
  godcast:      { section: '◈ STATUS ENGINE',    syntax: 'godcast',                   desc: 'Post designed status for current group',      target: 'main' },
  statusdesign: { section: '◈ STATUS ENGINE',    syntax: 'statusdesign',              desc: 'Post designed status for current group',      target: 'main' },
  settheme:     { section: '◈ STATUS ENGINE',    syntax: 'settheme [theme]',          desc: 'Set default status theme for this group',     target: 'main' },
  smedia:       { section: '◈ STATUS ENGINE',    syntax: 'smedia',                    desc: 'Post media status',                           target: 'main' },
  gstatus:      { section: '◈ STATUS ENGINE',    syntax: 'gstatus [msg]',             desc: 'Post text to current group status',           target: 'main' },
  tochat:       { section: '◈ STATUS ENGINE',    syntax: 'tochat [jid] [msg]',        desc: 'Send message to a target group',              target: 'main' },
  togstatus:    { section: '◈ STATUS ENGINE',    syntax: 'togstatus [jid] [msg]',     desc: 'Post to a target group status',               target: 'main' },
  tochatx:      { section: '◈ STATUS ENGINE',    syntax: 'tochatx [jid] [n] [msg]',  desc: 'Repeat a message to a target group',          target: 'main' },
  togstatusx:   { section: '◈ STATUS ENGINE',    syntax: 'togstatusx [n] [jid] [msg]',desc: 'Repeat to a target group status',            target: 'main' },
  sstatus:      { section: '◈ STATUS ENGINE',    syntax: 'sstatus [msg]',             desc: 'Run status loop (until stopspam)',            target: 'main' },

  // ── Broadcast Network ─────────────────────────────────────
  allstatus:    { section: '◈ BROADCAST NETWORK', syntax: 'allstatus [msg]',          desc: 'Post to ALL group statuses',                 target: 'main' },
  allstatusx:   { section: '◈ BROADCAST NETWORK', syntax: 'allstatusx [n] [msg]',     desc: 'Repeat to every group status',               target: 'main' },
  allchat:      { section: '◈ BROADCAST NETWORK', syntax: 'allchat [msg]',            desc: 'Send to all groups with hidetag',            target: 'main' },
  stopspam:     { section: '◈ BROADCAST NETWORK', syntax: 'stopspam',                 desc: 'Stop the active status / outreach loop',     target: 'main' },
  stop:         { section: '◈ BROADCAST NETWORK', syntax: 'stop',                     desc: 'Alias for stopspam',                         target: 'main', hidden: true },

  // ── Tag Engine ────────────────────────────────────────────
  tag:          { section: '◈ TAG ENGINE',       syntax: 'tag',                       desc: 'Hidetag all group members',                  target: 'both' },
  mtag:         { section: '◈ TAG ENGINE',       syntax: 'mtag',                      desc: 'Visibly mention all group members',          target: 'both' },

  // ── Lifecycle ─────────────────────────────────────────────
  join:         { section: '◈ LIFECYCLE',        syntax: 'join [link]',               desc: 'Join a group by invite link',                target: 'main' },
  left:         { section: '◈ LIFECYCLE',        syntax: 'left',                      desc: 'Leave the current group',                    target: 'main' },
  leave:        { section: '◈ LIFECYCLE',        syntax: 'leave [jid]',               desc: 'Leave a specific group by JID',              target: 'main' },
  joinall:      { section: '◈ LIFECYCLE',        syntax: 'joinall',                   desc: 'Join every link in the active bucket',       target: 'main' },
  leaveall:     { section: '◈ LIFECYCLE',        syntax: 'leaveall',                  desc: 'Leave all joined groups',                    target: 'main' },

  // ── Pairing ───────────────────────────────────────────────
  pair:         { section: '◈ PAIRING',          syntax: 'pair [phone]',              desc: 'Pair a new WhatsApp number from inside WA',  target: 'main' },

  // ── Bucket ────────────────────────────────────────────────
  addlink:      { section: '◈ BUCKET',           syntax: 'addlink [link…]',           desc: 'Add invite links to the main bucket',        target: 'main' },

  // ── System Config ─────────────────────────────────────────
  setprefix:    { section: '◈ SYSTEM CONFIG',    syntax: 'setprefix [p]',             desc: 'Change the command prefix',                  target: 'main' },
  prefix:       { section: '◈ SYSTEM CONFIG',    syntax: 'prefix',                    desc: 'Show the current prefix',                    target: 'main', hidden: true },
  setcmd:       { section: '◈ SYSTEM CONFIG',    syntax: 'setcmd [cmd]',              desc: 'Bind a quoted sticker to a command',         target: 'main' },
  delcmd:       { section: '◈ SYSTEM CONFIG',    syntax: 'delcmd',                    desc: 'Remove a sticker binding',                   target: 'main' },
  setmenupic:   { section: '◈ SYSTEM CONFIG',    syntax: 'setmenupic',                desc: 'Set replied image as menu media',             target: 'main' },
  setmenuvideo: { section: '◈ SYSTEM CONFIG',    syntax: 'setmenuvideo',              desc: 'Set replied video as menu media',             target: 'main' },
  delmenumedia: { section: '◈ SYSTEM CONFIG',    syntax: 'delmenumedia',              desc: 'Restore default text-only menus',             target: 'main' },
  setsudo:      { section: '◈ SYSTEM CONFIG',    syntax: 'setsudo [number]',          desc: 'Grant command access (or reply to msg)',      target: 'main' },
  delsudo:      { section: '◈ SYSTEM CONFIG',    syntax: 'delsudo [number]',          desc: 'Revoke command access',                      target: 'main' },
  sudo:         { section: '◈ SYSTEM CONFIG',    syntax: 'sudo',                      desc: 'List all sudo numbers',                      target: 'main' },
  info:         { section: '◈ SYSTEM CONFIG',    syntax: 'info',                      desc: 'Session info and status',                    target: 'main' },
  groups:       { section: '◈ SYSTEM CONFIG',    syntax: 'groups',                    desc: 'List all joined groups',                     target: 'main' },
  ping:         { section: '◈ SYSTEM CONFIG',    syntax: 'ping',                      desc: 'Check bot latency',                          target: 'main' },
  jid:          { section: '◈ SYSTEM CONFIG',    syntax: 'jid',                       desc: 'Show the current group JID',                 target: 'main' },
  userinfo:     { section: '◈ SYSTEM CONFIG',    syntax: 'userinfo',                  desc: 'Show user JID, number & LID',                target: 'main' },
  getinfo:      { section: '◈ SYSTEM CONFIG',    syntax: 'getinfo',                   desc: 'Alias for userinfo',                         target: 'main', hidden: true },
  spam:         { section: '◈ SYSTEM CONFIG',    syntax: 'spam',                      desc: 'Alias for sstatus',                          target: 'main', hidden: true },
  menu:         { section: '◈ SYSTEM CONFIG',    syntax: 'menu',                      desc: 'Show general command menu',                  target: 'main', hidden: true },
  help:         { section: '◈ SYSTEM CONFIG',    syntax: 'help',                      desc: 'Alias for menu',                             target: 'main', hidden: true },
  gmenu:        { section: '◈ SYSTEM CONFIG',    syntax: 'gmenu',                     desc: 'Show group moderation menu',                 target: 'group', hidden: true },

  // ── Group Moderation ──────────────────────────────────────
  kick:         { section: '◈ GROUP MODERATION', syntax: 'kick',                      desc: 'Kick member (reply / @mention / number)',     target: 'group' },
  remove:       { section: '◈ GROUP MODERATION', syntax: 'remove',                    desc: 'Alias for kick',                             target: 'group', hidden: true },
  dnkick:       { section: '◈ GROUP MODERATION', syntax: 'dnkick',                    desc: 'Demote then kick an admin safely',           target: 'group' },
  ban:          { section: '◈ GROUP MODERATION', syntax: 'ban',                       desc: 'Ban a member (kick + block)',                target: 'group' },
  unban:        { section: '◈ GROUP MODERATION', syntax: 'unban',                     desc: 'Remove a member from the ban list',          target: 'group' },
  banlist:      { section: '◈ GROUP MODERATION', syntax: 'banlist',                   desc: 'View the ban list for this group',           target: 'group' },
  promote:      { section: '◈ GROUP MODERATION', syntax: 'promote',                   desc: 'Grant admin to a member',                    target: 'group' },
  demote:       { section: '◈ GROUP MODERATION', syntax: 'demote',                    desc: 'Remove admin from a member',                 target: 'group' },
  warn:         { section: '◈ GROUP MODERATION', syntax: 'warn',                      desc: 'Issue a warning to a member',               target: 'group' },
  unwarn:       { section: '◈ GROUP MODERATION', syntax: 'unwarn',                    desc: 'Clear one warning from a member',            target: 'group' },
  resetwarn:    { section: '◈ GROUP MODERATION', syntax: 'resetwarn',                 desc: 'Reset all warnings for a member',            target: 'group' },
  warns:        { section: '◈ GROUP MODERATION', syntax: 'warns',                     desc: 'Show warning count for a member',            target: 'group' },
  poll:         { section: '◈ GROUP MODERATION', syntax: 'poll Q|A|B',               desc: 'Create a group poll',                        target: 'group' },
  blockall:     { section: '◈ GROUP MODERATION', syntax: 'blockall',                  desc: 'Batch-kick all non-admin members',            target: 'group' },
  autoblock:    { section: '◈ GROUP MODERATION', syntax: 'autoblock <on|off>',        desc: 'Auto-kick every new joiner',                 target: 'group' },
  setwelcome:   { section: '◈ GROUP MODERATION', syntax: 'setwelcome [msg]',          desc: 'Set welcome message (use off to disable)',   target: 'group' },
  welcomemsg:   { section: '◈ GROUP MODERATION', syntax: 'welcomemsg [msg]',          desc: 'Alias for setwelcome',                       target: 'group', hidden: true },
  welcome:      { section: '◈ GROUP MODERATION', syntax: 'welcome',                   desc: 'Toggle welcome messages on/off',             target: 'group' },
  setgoodbye:   { section: '◈ GROUP MODERATION', syntax: 'setgoodbye [msg]',          desc: 'Set goodbye message (use off to disable)',   target: 'group' },
  goodbyemsg:   { section: '◈ GROUP MODERATION', syntax: 'goodbyemsg [msg]',          desc: 'Alias for setgoodbye',                       target: 'group', hidden: true },
  goodbye:      { section: '◈ GROUP MODERATION', syntax: 'goodbye',                   desc: 'Toggle goodbye messages on/off',             target: 'group' },
  kickmsg:      { section: '◈ GROUP MODERATION', syntax: 'kickmsg [text]',            desc: 'Customise kick response message',            target: 'group' },
  warnmsg:      { section: '◈ GROUP MODERATION', syntax: 'warnmsg [text]',            desc: 'Customise warn response message',            target: 'group' },
  banmsg:       { section: '◈ GROUP MODERATION', syntax: 'banmsg [text]',             desc: 'Customise ban response message',             target: 'group' },
  unbanmsg:     { section: '◈ GROUP MODERATION', syntax: 'unbanmsg [text]',           desc: 'Customise unban response message',           target: 'group' },
  eventstatus:  { section: '◈ GROUP MODERATION', syntax: 'eventstatus',               desc: 'Group event config overview',                target: 'group' },

  // ── Anti System — Overview ────────────────────────────────
  antistatus:   { section: '◈ ANTI SYSTEM',      syntax: 'antistatus',                desc: 'Show all anti modules status for this group', target: 'group' },

  // AntiLink
  antilink:     { section: '◈ ANTI SYSTEM',      syntax: 'antilink <kick|warn N|delete|off>', desc: 'Block all links in the group',        target: 'group' },
  linkpermit:   { section: '◈ ANTI SYSTEM',      syntax: 'linkpermit @user',          desc: 'Exempt a user from AntiLink',                target: 'group' },
  rmlinkpermit: { section: '◈ ANTI SYSTEM',      syntax: 'rmlinkpermit @user',        desc: 'Remove AntiLink exemption',                  target: 'group', hidden: true },
  antilinkmsg:  { section: '◈ ANTI SYSTEM',      syntax: 'antilinkmsg [text]',        desc: 'Set custom AntiLink violation message',      target: 'group', hidden: true },

  // AntiBot
  antibot:      { section: '◈ ANTI SYSTEM',      syntax: 'antibot <kick|warn N|delete|off>', desc: 'Remove automation/bot clients',       target: 'group' },
  botpermit:    { section: '◈ ANTI SYSTEM',      syntax: 'botpermit @user',           desc: 'Exempt a user from AntiBot',                 target: 'group', hidden: true },
  rmbotpermit:  { section: '◈ ANTI SYSTEM',      syntax: 'rmbotpermit @user',         desc: 'Remove AntiBot exemption',                   target: 'group', hidden: true },

  // AntiSpam
  antispam:     { section: '◈ ANTI SYSTEM',      syntax: 'antispam <kick|warn N|delete|off>', desc: 'Rate-limit spammers (default 10 msg/5s)', target: 'group' },
  spamlimit:    { section: '◈ ANTI SYSTEM',      syntax: 'spamlimit <msgs> <secs>',   desc: 'Adjust spam detection window',               target: 'group' },
  spampermit:   { section: '◈ ANTI SYSTEM',      syntax: 'spampermit @user',          desc: 'Exempt a user from AntiSpam',                target: 'group', hidden: true },
  rmspampermit: { section: '◈ ANTI SYSTEM',      syntax: 'rmspampermit @user',        desc: 'Remove AntiSpam exemption',                  target: 'group', hidden: true },
  antispammsg:  { section: '◈ ANTI SYSTEM',      syntax: 'antispammsg [text]',        desc: 'Custom AntiSpam message',                    target: 'group', hidden: true },

  // AntiMedia
  antipic:      { section: '◈ ANTI SYSTEM',      syntax: 'antipic <kick|warn N|delete|off>', desc: 'Block image messages',                target: 'group' },
  antivid:      { section: '◈ ANTI SYSTEM',      syntax: 'antivid <kick|warn N|delete|off>', desc: 'Block video messages',                target: 'group' },
  antiaud:      { section: '◈ ANTI SYSTEM',      syntax: 'antiaud <kick|warn N|delete|off>', desc: 'Block audio messages',               target: 'group' },
  picpermit:    { section: '◈ ANTI SYSTEM',      syntax: 'picpermit @user',           desc: 'Exempt from AntiPic',                        target: 'group', hidden: true },
  rmpicpermit:  { section: '◈ ANTI SYSTEM',      syntax: 'rmpicpermit @user',         desc: 'Remove AntiPic exemption',                   target: 'group', hidden: true },
  vidpermit:    { section: '◈ ANTI SYSTEM',      syntax: 'vidpermit @user',           desc: 'Exempt from AntiVid',                        target: 'group', hidden: true },
  rmvidpermit:  { section: '◈ ANTI SYSTEM',      syntax: 'rmvidpermit @user',         desc: 'Remove AntiVid exemption',                   target: 'group', hidden: true },
  audpermit:    { section: '◈ ANTI SYSTEM',      syntax: 'audpermit @user',           desc: 'Exempt from AntiAud',                        target: 'group', hidden: true },
  rmaudpermit:  { section: '◈ ANTI SYSTEM',      syntax: 'rmaudpermit @user',         desc: 'Remove AntiAud exemption',                   target: 'group', hidden: true },

  // AntiVN
  antivn:       { section: '◈ ANTI SYSTEM',      syntax: 'antivn <kick|warn N|delete|off>', desc: 'Block voice notes',                   target: 'group' },
  vnpermit:     { section: '◈ ANTI SYSTEM',      syntax: 'vnpermit @user',            desc: 'Exempt from AntiVN',                         target: 'group', hidden: true },
  rmvnpermit:   { section: '◈ ANTI SYSTEM',      syntax: 'rmvnpermit @user',          desc: 'Remove AntiVN exemption',                    target: 'group', hidden: true },
  antivnmsg:    { section: '◈ ANTI SYSTEM',      syntax: 'antivnmsg [text]',          desc: 'Custom AntiVN message',                      target: 'group', hidden: true },

  // AntiText
  antitxt:      { section: '◈ ANTI SYSTEM',      syntax: 'antitxt <kick|warn N|delete|off>', desc: 'Block plain text messages',           target: 'group' },

  // AntiEmoji
  antiemoji:    { section: '◈ ANTI SYSTEM',      syntax: 'antiemoji <kick|warn N|delete|off>', desc: 'Block emoji messages',             target: 'group' },
  emojipermit:  { section: '◈ ANTI SYSTEM',      syntax: 'emojipermit @user',         desc: 'Exempt from AntiEmoji',                      target: 'group', hidden: true },
  rmemojipermit:{ section: '◈ ANTI SYSTEM',      syntax: 'rmemojipermit @user',       desc: 'Remove AntiEmoji exemption',                 target: 'group', hidden: true },
  antiemojimsg: { section: '◈ ANTI SYSTEM',      syntax: 'antiemojimsg [text]',       desc: 'Custom AntiEmoji message',                   target: 'group', hidden: true },

  // AntiSticker
  antisticker:  { section: '◈ ANTI SYSTEM',      syntax: 'antisticker <kick|warn N|delete|off>', desc: 'Block sticker messages',         target: 'group' },
  sticpermit:   { section: '◈ ANTI SYSTEM',      syntax: 'sticpermit @user',          desc: 'Exempt from AntiSticker',                    target: 'group', hidden: true },
  rmsticpermit: { section: '◈ ANTI SYSTEM',      syntax: 'rmsticpermit @user',        desc: 'Remove AntiSticker exemption',               target: 'group', hidden: true },

  // AntiGroupCall
  antigroupcall:{ section: '◈ ANTI SYSTEM',      syntax: 'antigroupcall <kick|warn N|delete|off>', desc: 'Block group calls',           target: 'group' },

  // AntiNSFW
  antinsfw:     { section: '◈ ANTI SYSTEM',      syntax: 'antinsfw <kick|warn N|delete|off>', desc: 'Block NSFW images & videos (needs API)', target: 'group' },
  nsfwpermit:   { section: '◈ ANTI SYSTEM',      syntax: 'nsfwpermit @user',          desc: 'Exempt from AntiNSFW',                       target: 'group', hidden: true },
  rmnsfwpermit: { section: '◈ ANTI SYSTEM',      syntax: 'rmnsfwpermit @user',        desc: 'Remove AntiNSFW exemption',                  target: 'group', hidden: true },

  // AntiGroupMention
  antigroupmention: { section: '◈ ANTI SYSTEM',  syntax: 'antigroupmention <kick|warn N|delete|off>', desc: 'Block @group / channel mention blasts', target: 'group' },
  antigm: { section: '◈ ANTI SYSTEM', syntax: 'antigm <kick|warn N|delete|off>', desc: 'Handle WhatsApp Status group mentions', target: 'group' },
  mentionpermit:    { section: '◈ ANTI SYSTEM',  syntax: 'mentionpermit @user',       desc: 'Exempt from AntiGroupMention',               target: 'group', hidden: true },
  rmmentionpermit:  { section: '◈ ANTI SYSTEM',  syntax: 'rmmentionpermit @user',     desc: 'Remove AntiGroupMention exemption',          target: 'group', hidden: true },

  // AntiWords
  antiwords:    { section: '◈ ANTI SYSTEM',      syntax: 'antiwords <kick|warn N|delete|off>', desc: 'Block messages with blocked words', target: 'group' },
  antiaddword:  { section: '◈ ANTI SYSTEM',      syntax: 'antiaddword <word>',        desc: 'Add a word to the blocklist',                target: 'group' },
  antirmword:   { section: '◈ ANTI SYSTEM',      syntax: 'antirmword <word>',         desc: 'Remove a word from the blocklist',           target: 'group' },
  antiwordlist: { section: '◈ ANTI SYSTEM',      syntax: 'antiwordlist',              desc: 'Show all blocked words',                     target: 'group' },
  antiwordsmsg: { section: '◈ ANTI SYSTEM',      syntax: 'antiwordsmsg [text]',       desc: 'Custom AntiWords message',                   target: 'group', hidden: true },

  // AntiPoll
  antipoll:     { section: '◈ ANTI SYSTEM',      syntax: 'antipoll <kick|warn N|delete|off>', desc: 'Block poll creation',               target: 'group' },
  pollpermit:   { section: '◈ ANTI SYSTEM',      syntax: 'pollpermit @user',          desc: 'Exempt from AntiPoll',                       target: 'group', hidden: true },
  rmpollpermit: { section: '◈ ANTI SYSTEM',      syntax: 'rmpollpermit @user',        desc: 'Remove AntiPoll exemption',                  target: 'group', hidden: true },

  // AntiForward
  antiforward:  { section: '◈ ANTI SYSTEM',      syntax: 'antiforward <kick|warn N|delete|off>', desc: 'Block forwarded messages',       target: 'group' },
  fwdpermit:    { section: '◈ ANTI SYSTEM',      syntax: 'fwdpermit @user',           desc: 'Exempt from AntiForward',                    target: 'group', hidden: true },
  rmfwdpermit:  { section: '◈ ANTI SYSTEM',      syntax: 'rmfwdpermit @user',         desc: 'Remove AntiForward exemption',               target: 'group', hidden: true },

  // AntiChannel
  antichannel:  { section: '◈ ANTI SYSTEM',      syntax: 'antichannel <kick|warn N|delete|off>', desc: 'Block forwarded channel posts',  target: 'group' },
  chanpermit:   { section: '◈ ANTI SYSTEM',      syntax: 'chanpermit @user',          desc: 'Exempt from AntiChannel',                    target: 'group', hidden: true },
  rmchanpermit: { section: '◈ ANTI SYSTEM',      syntax: 'rmchanpermit @user',        desc: 'Remove AntiChannel exemption',               target: 'group', hidden: true },

  // AntiPromote / AntiDemote
  antipromote:  { section: '◈ ANTI SYSTEM',      syntax: 'antipromote <kick|warn N|delete|off>', desc: 'React to unauthorized admin promotions', target: 'group' },
  antidemote:   { section: '◈ ANTI SYSTEM',      syntax: 'antidemote <dwp|dnp|kwp|knp|off>', desc: 'React to unauthorized admin demotions', target: 'group' },

  // ── Join Approval ─────────────────────────────────────────
  // Mirror of the Telegram per-group dashboard approval features,
  // now accessible directly from WhatsApp.
  pendingjoin:    { section: '◈ JOIN APPROVAL',   syntax: 'pendingjoin',                  desc: 'List pending join requests',                 target: 'group' },
  approveall:     { section: '◈ JOIN APPROVAL',   syntax: 'approveall',                   desc: 'Approve ALL pending join requests',          target: 'group' },
  rejectall:      { section: '◈ JOIN APPROVAL',   syntax: 'rejectall',                    desc: 'Reject ALL pending join requests',           target: 'group' },
  approveamt:     { section: '◈ JOIN APPROVAL',   syntax: 'approveamt <n>',               desc: 'Approve first N pending requests',           target: 'group' },
  approvecountry: { section: '◈ JOIN APPROVAL',   syntax: 'approvecountry <+code>',       desc: 'Approve requests by phone country code',     target: 'group' },
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

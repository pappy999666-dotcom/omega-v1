// ============================================================
// WA-Bridge — Dynamic Command Parser
// Supports: custom prefixes, null-prefix, space-tolerance,
// Levenshtein typo-tolerance, sticker-triggered macros
// ============================================================

import crypto from 'crypto';
import type { ParsedCommand, UserConfig } from '../types/index.js';
import { normalizeCommandString, fuzzyMatchCommand } from '../utils/levenshtein.js';

// All registered command names (populated at startup)
let KNOWN_COMMANDS: string[] = [];

export function registerCommands(commands: string[]): void {
  KNOWN_COMMANDS = commands;
}

// ── Main Parser ───────────────────────────────────────────

/**
 * Parse a raw WhatsApp message text into a structured command.
 * Returns null if the message is not a command.
 */
export function parseCommand(
  text: string,
  config: UserConfig
): ParsedCommand | null {
  const normalized = normalizeCommandString(text);

  if (!normalized) return null;

  const { prefix, nullPrefix } = config;

  let body: string;

  if (nullPrefix) {
    // Null-prefix mode: treat every message as a potential command
    body = normalized;
  } else if (prefix) {
    // Dynamic prefix — strip leading whitespace around the prefix
    // Handles: ".menu", ". menu", " .menu" etc.
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRe = new RegExp(`^\\s*${escapedPrefix}`);

    if (!prefixRe.test(normalized)) return null;
    // Remove prefix and any leading space to get to the command word
    body = normalized.replace(prefixRe, '').trimStart();
  } else {
    return null;
  }

  if (!body) return null;

  // Split only on the first whitespace to get the command word.
  // Everything after is kept raw so newlines and exact spacing are preserved.
  const firstWs = body.search(/\s/);
  let command = (firstWs === -1 ? body : body.slice(0, firstWs)).toLowerCase();
  
  // rawRemainder: everything after the command word, including the first whitespace if any
  const rawRemainder = firstWs === -1 ? '' : body.slice(firstWs);
  
  // For legacy compatibility, args array still exists but we should prefer rawRemainder
  // We trim the first whitespace from args for backward compatibility with simple commands
  const argsText = rawRemainder.trimStart();
  const args = argsText ? argsText.split(/ +/).filter(Boolean) : [];
  const aliases: Record<string, string> = {
    antitext: 'antitxt',
    left: 'left',
    stopspam: 'stopspam',
    togstatusx: 'togstatusx',
    allstatusx: 'allstatusx',
    tictactoe: 'ttt',
  };
  command = aliases[command] ?? command;

  // Typo-tolerance: try to match against known commands
  if (!KNOWN_COMMANDS.includes(command)) {
    // Always-listen mode must be exact so ordinary conversation cannot wake the bot.
    if (nullPrefix) return null;
    const fuzzy = fuzzyMatchCommand(command, KNOWN_COMMANDS, 1);
    if (fuzzy) command = fuzzy;
    else return null;
  }

  return {
    prefix,
    command,
    args,
    rawRemainder,
    raw: text,
  };
}

/**
 * Parse a command from a sticker message.
 * Returns the macro command if the sticker hash is registered.
 */
export function parseStickerCommand(
  stickerData: Buffer | Uint8Array | string,
  config: UserConfig
): ParsedCommand | null {
  const hash = hashSticker(stickerData);
  const macroCmd = config.stickerMacros[hash];

  if (!macroCmd) return null;

  // The stored binding has NO prefix (e.g. "tag"). Use the session prefix, but
  // fall back to '.' when the session has an empty/null prefix so sticker
  // macros still fire on null-prefix sessions (matches setcmd validation).
  const pfx = config.prefix && config.prefix.trim() ? config.prefix : '.';
  const parsed = parseCommand(`${pfx}${macroCmd}`, {
    ...config,
    prefix: pfx,
    nullPrefix: false, // Force prefix for sticker macros
  });

  return parsed ? {
    ...parsed,
    fromSticker: true,
    stickerHash: hash,
  } : null;
}

/**
 * Compute a stable SHA-256 hash for a sticker buffer.
 * Handles both Buffer/Uint8Array and base64 string inputs from Baileys.
 */
export function hashSticker(bufferOrB64: Buffer | Uint8Array | string): string {
  const buf = typeof bufferOrB64 === 'string'
    ? Buffer.from(bufferOrB64, 'base64')
    : Buffer.from(bufferOrB64);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// ── Command Registry Helper ───────────────────────────────

export const ALL_COMMANDS = [
  // Status & Target Broadcast
  'godcast', 'gstatus', 'tochat', 'togstatus', 'tochatx', 'togstatusx', 'sstatus', 'statusdesign', 'settheme', 'smedia',
  // Mass Outreach
  'allstatus', 'allgstatus', 'allchat', 'allstatusx',
  // Lifecycle
  'join', 'joinall', 'left', 'leave', 'leaveall',
  // Tagging
  'tag', 'mtag',
  // Games
  'wcg', 'ttt', 'tictactoe',
  // ── Poll Game Engine (AI-powered) ──
  'wyr', 'quiz', 'gameapi',
  // Stop
  'stop', 'stopspam', 'spam',
  // Settings
  'setprefix', 'setcmd', 'delcmd', 'setmenupic', 'setmenuvideo', 'delmenumedia', 'setpfp', 'getpfp', 'removepfp', 'setname', 'setbio', 'wainfo', 'creategc', 'collect', 'autopromo', 'setsudo', 'delsudo', 'sudo', 'prefix', 'public', 'setmode', 'publicresponse', 'tagreply',
  // Response Mode + Timezone
  'swresponse', 'settimezone',
  // Info
  'menu', 'help', 'gmenu', 'ping', 'info', 'groups', 'jid', 'userinfo', 'getinfo', 'idea',
  // Bucket
  'addlink',
  // Sticker System
  'sticker', 'setpackname', 'setauthor', 'listcmd', 'qc', 'tg',
  // Group Moderation
  'kick', 'remove', 'ban', 'unban', 'banlist',
  'promote', 'demote', 'dnkick',
  'warn', 'unwarn', 'resetwarn', 'warns',
  'block', 'deleteall',
  'poll',
  'mute', 'unmute',
  'blockall', 'autoblock',
  'stopjoin',
  'setwelcome', 'welcomemsg', 'welcome',
  'setgoodbye', 'goodbyemsg', 'goodbye',
  'kickmsg', 'warnmsg', 'banmsg', 'unbanmsg',
  'eventstatus',
  // Session Management
  'ls', 'curr', 'switch', 'sinfo', 'restart', 'disconnect', 'delete', 'rename', 'freeze', 'unfreeze',
  // Pairing from WhatsApp
  'pair',
  // ── Anti System ──
  'antistatus',
  // AntiLink
  'antilink', 'linkpermit', 'rmlinkpermit', 'antilinkmsg',
  // AntiBot
  'antibot', 'botpermit', 'rmbotpermit',
  // AntiSpam
  'antispam', 'spamlimit', 'spampermit', 'rmspampermit', 'antispammsg',
  // AntiPic
  'antipic', 'picpermit', 'rmpicpermit',
  // AntiVid
  'antivid', 'vidpermit', 'rmvidpermit',
  // AntiAud
  'antiaud', 'audpermit', 'rmaudpermit',
  // AntiVN
  'antivn', 'vnpermit', 'rmvnpermit', 'antivnmsg',
  // AntiText (antitext is the user-facing spelling; antitxt remains compatible)
  'antitxt', 'antitext',
  // AntiEmoji
  'antiemoji', 'emojipermit', 'rmemojipermit', 'antiemojimsg',
  // AntiSticker
  'antisticker', 'sticpermit', 'rmsticpermit',
  // AntiGroupCall
  'antigroupcall',
  // AntiNSFW
  'antinsfw', 'nsfwpermit', 'rmnsfwpermit',
  // AntiGroupMention
  'antigroupmention', 'mentionpermit', 'rmmentionpermit',
  'antigm', 'gmpermit', 'rmgmpermit',
  // AntiWords
  'antiwords', 'antiaddword', 'antirmword', 'antiwordlist', 'antiwordsmsg',
  'setantiwords', 'rmantiwords', 'clearantiwords',
  // AntiPoll
  'antipoll', 'pollpermit', 'rmpollpermit',
  // AntiForward
  'antiforward', 'fwdpermit', 'rmfwdpermit',
  // AntiChannel
  'antichannel', 'chanpermit', 'rmchanpermit',
  // AntiPromote
  'antipromote',
  // AntiDemote
  'antidemote',
  // Join Approval (WhatsApp-side)
  'pendingjoin', 'approveall', 'rejectall', 'approveamt', 'approvecountry',
  // ── Personal Engine (View Once · Anti Delete · Status Platform) ──
  'vv', 'vvdm', 'autovv',
  'antidelete',
  'pstatus', 'autosend', 'autodstatus', 'autostatusreact',
  'antigstatus',
] as const;

export type CommandName = typeof ALL_COMMANDS[number];

// Register all commands at startup
registerCommands([...ALL_COMMANDS]);

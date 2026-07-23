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
    const prefixRe = new RegExp(`^\\s*${escapedPrefix}\\s*`);

    if (!prefixRe.test(normalized)) return null;
    body = normalized.replace(prefixRe, '').trim();
  } else {
    return null;
  }

  if (!body) return null;

  const parts = body.split(/\s+/);
  let command = parts[0]!.toLowerCase();
  const args = parts.slice(1);

  // Typo-tolerance: try to match against known commands
  if (!KNOWN_COMMANDS.includes(command)) {
    const fuzzy = fuzzyMatchCommand(command, KNOWN_COMMANDS, 1);
    if (fuzzy) command = fuzzy;
    else return null; // Unknown command, not even close
  }

  return {
    prefix,
    command,
    args,
    raw: text,
  };
}

/**
 * Parse a command from a sticker message.
 * Returns the macro command if the sticker hash is registered.
 */
export function parseStickerCommand(
  stickerBuffer: Buffer,
  config: UserConfig
): ParsedCommand | null {
  const hash = hashSticker(stickerBuffer);
  const macroCmd = config.stickerMacros[hash];

  if (!macroCmd) return null;

  return parseCommand(`${config.prefix}${macroCmd}`, {
    ...config,
    nullPrefix: false, // Force prefix for sticker macros
  }) ?? {
    prefix: config.prefix,
    command: macroCmd,
    args: [],
    raw: macroCmd,
    fromSticker: true,
    stickerHash: hash,
  };
}

/**
 * Compute a stable SHA-256 hash for a sticker buffer.
 * Used to bind sticker hashes to macros (.setcmd [hash] [cmd]).
 */
export function hashSticker(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

// ── Command Registry Helper ───────────────────────────────

export const ALL_COMMANDS = [
  // Status & Target Broadcast
  'gstatus', 'tochat', 'tochatx', 'sstatus',
  // Mass Outreach
  'allstatus', 'allchat',
  // Lifecycle
  'join', 'leave', 'joinall', 'leaveall',
  // Tagging
  'tag', 'mtag',
  // Stop
  'stop',
  // Settings
  'setprefix', 'setcmd', 'prefix',
  // Info
  'menu', 'help', 'ping', 'info', 'groups', 'jid',
  // Bucket
  'addlink', 'bucket', 'listlinks',
] as const;

export type CommandName = typeof ALL_COMMANDS[number];

// Register all commands at startup
registerCommands([...ALL_COMMANDS]);

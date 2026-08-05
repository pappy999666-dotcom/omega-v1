// ============================================================
// Anti System — Command Handlers
// All anti commands are handled here and return reply strings.
// ============================================================

import type { WebMessageInfo } from '../baileys-types.js';
import { bold, italic, successCard, warningCard, errorCard, asciiBox } from '../../utils/ascii-art.js';
import { resolveTargetNumber } from '../utils/resolve-target.js';
import {
  loadGroupAntiConfig,
  saveGroupAntiConfig,
  setModuleConfig,
  addPermit,
  removePermit,
  setCustomMessage,
  setSpamLimit,
  addWord,
  removeWord,
  setDemoteMode,
  setPromoteMode,
  defaultModuleConfig,
  defaultSpamConfig,
  defaultWordsConfig,
  defaultDemoteConfig,
  defaultPromoteConfig,
} from './config.js';
import type {
  AntiAction,
  AntiModuleConfig,
  AntiSpamConfig,
  AntiWordsConfig,
  AntiDemoteMode,
  GroupAntiConfig,
  GroupSecurityMode,
  AntiPromoteConfig,
  AntiDemoteConfig,
} from './types.js';

// ── Utilities ────────────────────────────────────────────────

function parseAction(arg: string): AntiAction | null {
  if (['kick', 'warn', 'delete'].includes(arg)) return arg as AntiAction;
  return null;
}


function moduleLabel(key: string): string {
  const labels: Record<string, string> = {
    antilink: 'AntiLink', antibot: 'AntiBot', antispam: 'AntiSpam',
    antipic: 'AntiPic', antivid: 'AntiVid', antiaud: 'AntiAud',
    antivn: 'AntiVN', antitxt: 'AntiText', antiemoji: 'AntiEmoji',
    antisticker: 'AntiSticker', antigroupcall: 'AntiGroupCall',
    antinsfw: 'AntiNSFW', antigroupmention: 'AntiGroupMention', antigm: 'AntiGM',
    antiwords: 'AntiWords', antipoll: 'AntiPoll', antiforward: 'AntiForward',
    antichannel: 'AntiChannel', antipromote: 'AntiPromote', antidemote: 'AntiDemote',
  };
  return labels[key] ?? key;
}

// ── Generic enable/disable for a module ──────────────────────

export function handleAntiCommand(
  command: string,          // e.g. "antilink"
  moduleKey: keyof Omit<GroupAntiConfig, 'groupJid' | 'messages'>,
  args: string[],
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Anti System', 'This command must be used inside a WhatsApp group.');
  }

  const subCmd = args[0]?.toLowerCase();

  // Turn off
  if (subCmd === 'off') {
    const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
    const mod = gc[moduleKey] as AntiModuleConfig | undefined;
    if (!mod?.enabled) {
      return warningCard(moduleLabel(moduleKey), 'Already disabled in this group.');
    }
    mod.enabled = false;
    saveGroupAntiConfig(telegramId, sessionId, gc);
    return successCard(moduleLabel(moduleKey), 'Disabled in this group.');
  }

  const action = parseAction(subCmd ?? '');
  if (!action) {
    return errorCard(
      moduleLabel(moduleKey),
      `Usage: ${prefix}${command} <kick|warn|delete|off>\n` +
      `Warn threshold: ${prefix}${command} warn [count]\n` +
      `To disable: ${prefix}${command} off`
    );
  }

  const warnThreshold = action === 'warn'
    ? parseInt(args[1] ?? '3', 10) || 3
    : 3;

  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const persisted = gc[moduleKey] as AntiModuleConfig | undefined;
  // For antispam, merge defaultSpamConfig() *beneath* the persisted config so that
  // legacy configs missing messageLimit/windowSeconds always have those fields defined.
  // Existing configured values remain authoritative; defaults only fill gaps.
  const existing =
    moduleKey === 'antispam'
      ? { ...defaultSpamConfig(), ...(persisted ?? {}) }
      : (persisted ?? defaultModuleConfig());
  (gc as unknown as Record<string, unknown>)[moduleKey] = {
    ...existing,
    enabled: true,
    action,
    warnThreshold,
  } as AntiModuleConfig;
  saveGroupAntiConfig(telegramId, sessionId, gc);

  const actionStr = action === 'warn' ? `warn (kick after ${warnThreshold})` : action;
  return successCard(
    moduleLabel(moduleKey),
    `Enabled with action: ${bold(actionStr)}\n` +
    `To disable later, use "${italic(`${prefix}${command} off`)}".`,
    [['Group', groupJid.split('@')[0] ?? '']]
  );
}

// ── Permit commands ───────────────────────────────────────────

export function handlePermitCommand(
  moduleKey: keyof Omit<GroupAntiConfig, 'groupJid' | 'messages'>,
  add: boolean,
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Anti System', 'This command must be used inside a WhatsApp group.');
  }
  const number = resolveTargetNumber(args, msg);
  if (!number) {
    return errorCard('Permit', 'Provide a number, @mention, or reply to a message.');
  }

  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const mod = gc[moduleKey] as AntiModuleConfig | undefined;
  if (!mod) {
    return warningCard('Permit', `${moduleLabel(moduleKey)} is not configured in this group yet.`);
  }

  if (add) {
    addPermit(telegramId, sessionId, groupJid, moduleKey, number);
    return successCard('Permit Added', `@${number} is now exempt from ${bold(moduleLabel(moduleKey))}.`, [['Module', moduleLabel(moduleKey)], ['Number', number]]);
  } else {
    removePermit(telegramId, sessionId, groupJid, moduleKey, number);
    return successCard('Permit Removed', `@${number} is no longer exempt from ${bold(moduleLabel(moduleKey))}.`, [['Module', moduleLabel(moduleKey)], ['Number', number]]);
  }
}

// ── Spam Limit ────────────────────────────────────────────────

export function handleSpamlimit(
  args: string[],
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('AntiSpam', 'This command must be used inside a WhatsApp group.');
  }
  const limit = parseInt(args[0] ?? '', 10);
  const seconds = parseInt(args[1] ?? '', 10);
  if (!limit || !seconds || limit < 1 || seconds < 1) {
    return errorCard('AntiSpam', `Usage: ${prefix}spamlimit <messages> <seconds>\nExample: ${prefix}spamlimit 15 8`);
  }
  setSpamLimit(telegramId, sessionId, groupJid, limit, seconds);
  return successCard('AntiSpam Limit Updated', `Rolling window: ${bold(String(limit))} messages in ${bold(String(seconds))} seconds.`);
}

// ── Custom Message ────────────────────────────────────────────

export function handleAntiMsg(
  moduleKey: string,
  args: string[],
  msg: WebMessageInfo,
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Anti System', 'This command must be used inside a WhatsApp group.');
  }
  // Use raw message text after the command word to preserve newlines
  const raw = msg.message?.extendedTextMessage?.text ?? msg.message?.conversation ?? '';
  const firstSpace = raw.search(/[ \t\n]/);
  const rawArgs = firstSpace !== -1 ? raw.slice(firstSpace + 1) : '';
  const quotedText =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ??
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text ??
    '';
  const message = rawArgs || quotedText;
  if (!message) {
    return errorCard('Anti System', 'Provide a custom message text or reply to a message.\nVariables: @mention, &gcname, &desc, &getpp');
  }
  setCustomMessage(telegramId, sessionId, groupJid, moduleKey, message);
  return successCard(`${moduleLabel(moduleKey)} Message`, `Custom response saved.\n${italic('Variables: @mention, &gcname, &desc, &getpp')}`, [['Preview', message.slice(0, 60)]]);
}

// ── AntiWords word management ────────────────────────────────

export function handleAntiAddWord(
  args: string[],
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('AntiWords', 'This command must be used inside a WhatsApp group.');
  }
  const word = args.join(' ').trim().toLowerCase();
  if (!word) return errorCard('AntiWords', 'Provide a word or phrase to block.');
  addWord(telegramId, sessionId, groupJid, word);
  return successCard('AntiWords', `"${bold(word)}" has been added to the blocked list.`);
}

export function handleAntiRemoveWord(
  args: string[],
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('AntiWords', 'This command must be used inside a WhatsApp group.');
  }
  const word = args.join(' ').trim().toLowerCase();
  if (!word) return errorCard('AntiWords', 'Provide the word or phrase to remove.');
  removeWord(telegramId, sessionId, groupJid, word);
  return successCard('AntiWords', `"${bold(word)}" has been removed from the blocked list.`);
}

export function handleAntiWordList(
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('AntiWords', 'This command must be used inside a WhatsApp group.');
  }
  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const words = gc.antiwords?.words ?? [];
  if (!words.length) return warningCard('AntiWords', 'No blocked words configured for this group.');
  return asciiBox({
    title: 'AntiWords — Blocked List',
    emoji: '🚫',
    rows: words.map((w, i) => [`${i + 1}`, w]),
    footer: `${words.length} word(s) blocked`,
  });
}

// ── Security module mode parser ───────────────────────────────

function parseSecurityMode(arg: string): GroupSecurityMode | null {
  const valid: GroupSecurityMode[] = [
    'off', 'warn', 'revert', 'kick', 'ban',
    // Legacy modes — mapped internally by the security engine:
    'dwp', 'dnp', 'kwp', 'knp',
  ];
  if (valid.includes(arg as GroupSecurityMode)) return arg as GroupSecurityMode;
  return null;
}

const SECURITY_MODE_USAGE =
  `${bold('warn')}   — warn actor, no role change\n` +
  `${bold('revert')} — undo the role change\n` +
  `${bold('kick')}   — revert + kick actor\n` +
  `${bold('ban')}    — revert + kick + block actor\n` +
  `${italic('Legacy:')} dwp (revert+warn) · dnp (revert) · kwp (kick+warn) · knp (kick)`;

// ── AntiPromote command handler ───────────────────────────────

/**
 * Handles: .antipromote on|off|mode <warn|revert|kick|ban>|status
 *
 * Examples:
 *   .antipromote on           → enable with current/default mode (revert)
 *   .antipromote off          → disable
 *   .antipromote mode revert  → set mode
 *   .antipromote status       → show config
 */
export function handleAntiPromoteCmd(
  args: string[],
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('AntiPromote', 'This command must be used inside a WhatsApp group.');
  }

  const subCmd = args[0]?.toLowerCase();

  // Status
  if (subCmd === 'status') {
    const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
    const mod = gc.antipromote as AntiPromoteConfig | undefined;
    if (!mod?.enabled) return warningCard('AntiPromote', 'Disabled in this group.');
    return successCard('AntiPromote', `Enabled\nMode: ${bold(mod.mode)}\nPermits: ${mod.permitList.length}`);
  }

  // Off
  if (subCmd === 'off') {
    const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
    const mod = gc.antipromote as AntiPromoteConfig | undefined;
    if (!mod?.enabled) return warningCard('AntiPromote', 'Already disabled.');
    mod.enabled = false;
    saveGroupAntiConfig(telegramId, sessionId, gc);
    return successCard('AntiPromote', 'Disabled in this group.');
  }

  // On (enable with current/default mode)
  if (subCmd === 'on') {
    const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
    const existing = (gc.antipromote ?? defaultPromoteConfig()) as AntiPromoteConfig;
    gc.antipromote = { ...existing, enabled: true };
    saveGroupAntiConfig(telegramId, sessionId, gc);
    return successCard(
      'AntiPromote Enabled',
      `Mode: ${bold(existing.mode)}\n` +
      `To change mode: ${italic(`${prefix}antipromote mode <warn|revert|kick|ban>`)}\n` +
      `To disable: ${italic(`${prefix}antipromote off`)}`,
    );
  }

  // Mode subcommand: .antipromote mode <warn|revert|kick|ban>
  if (subCmd === 'mode') {
    const modeArg = args[1]?.toLowerCase();
    const mode = modeArg ? parseSecurityMode(modeArg) : null;
    if (!mode || mode === 'off') {
      return errorCard(
        'AntiPromote',
        `Usage: ${prefix}antipromote mode <warn|revert|kick|ban>\n\n${SECURITY_MODE_USAGE}`
      );
    }
    setPromoteMode(telegramId, sessionId, groupJid, mode);
    return successCard(
      'AntiPromote Mode Set',
      `Mode: ${bold(mode)}\n${SECURITY_MODE_USAGE.split('\n').find((l) => l.includes(bold(mode))) ?? ''}\n` +
      `To disable: ${italic(`${prefix}antipromote off`)}`,
    );
  }

  // Direct mode shorthand: .antipromote warn|revert|kick|ban
  const directMode = parseSecurityMode(subCmd ?? '');
  if (directMode && directMode !== 'off') {
    setPromoteMode(telegramId, sessionId, groupJid, directMode);
    return successCard(
      'AntiPromote Enabled',
      `Mode: ${bold(directMode)}\nTo disable: ${italic(`${prefix}antipromote off`)}`,
    );
  }

  return errorCard(
    'AntiPromote',
    `Usage: ${prefix}antipromote <on|off|status|mode>\n\n` +
    `${italic('Modes:')}\n${SECURITY_MODE_USAGE}\n\n` +
    `Examples:\n` +
    `  ${prefix}antipromote on\n` +
    `  ${prefix}antipromote mode revert\n` +
    `  ${prefix}antipromote off`
  );
}

// ── AntiDemote command handler ────────────────────────────────

/**
 * Handles: .antidemote on|off|mode <warn|revert|kick|ban>|status
 *
 * Examples:
 *   .antidemote on           → enable with current/default mode (revert)
 *   .antidemote off          → disable
 *   .antidemote mode kick    → set mode
 *   .antidemote status       → show config
 */
export function handleAntiDemote(
  args: string[],
  telegramId: string,
  sessionId: string,
  groupJid: string,
  prefix: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('AntiDemote', 'This command must be used inside a WhatsApp group.');
  }

  const subCmd = args[0]?.toLowerCase();

  // Status
  if (subCmd === 'status') {
    const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
    const mod = gc.antidemote as AntiDemoteConfig | undefined;
    if (!mod?.enabled) return warningCard('AntiDemote', 'Disabled in this group.');
    return successCard('AntiDemote', `Enabled\nMode: ${bold(mod.mode)}\nPermits: ${mod.permitList.length}`);
  }

  // Off
  if (subCmd === 'off') {
    const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
    const mod = gc.antidemote as AntiDemoteConfig | undefined;
    if (!mod?.enabled) return warningCard('AntiDemote', 'Already disabled.');
    if (mod) mod.enabled = false;
    saveGroupAntiConfig(telegramId, sessionId, gc);
    return successCard('AntiDemote', 'Disabled in this group.');
  }

  // On (enable with current/default mode)
  if (subCmd === 'on') {
    const gc  = loadGroupAntiConfig(telegramId, sessionId, groupJid);
    const existing = (gc.antidemote ?? defaultDemoteConfig()) as AntiDemoteConfig;
    gc.antidemote = { ...existing, enabled: true };
    saveGroupAntiConfig(telegramId, sessionId, gc);
    return successCard(
      'AntiDemote Enabled',
      `Mode: ${bold(existing.mode)}\n` +
      `To change mode: ${italic(`${prefix}antidemote mode <warn|revert|kick|ban>`)}\n` +
      `To disable: ${italic(`${prefix}antidemote off`)}`,
    );
  }

  // Mode subcommand: .antidemote mode <warn|revert|kick|ban>
  if (subCmd === 'mode') {
    const modeArg = args[1]?.toLowerCase();
    const mode = modeArg ? parseSecurityMode(modeArg) : null;
    if (!mode || mode === 'off') {
      return errorCard(
        'AntiDemote',
        `Usage: ${prefix}antidemote mode <warn|revert|kick|ban>\n\n${SECURITY_MODE_USAGE}`
      );
    }
    setDemoteMode(telegramId, sessionId, groupJid, mode);
    return successCard(
      'AntiDemote Mode Set',
      `Mode: ${bold(mode)}\nTo disable: ${italic(`${prefix}antidemote off`)}`,
    );
  }

  // Direct mode shorthand: .antidemote warn|revert|kick|ban
  const directMode = parseSecurityMode(subCmd ?? '');
  if (directMode && directMode !== 'off') {
    setDemoteMode(telegramId, sessionId, groupJid, directMode);
    return successCard(
      'AntiDemote Enabled',
      `Mode: ${bold(directMode)}\nTo disable: ${italic(`${prefix}antidemote off`)}`,
    );
  }

  return errorCard(
    'AntiDemote',
    `Usage: ${prefix}antidemote <on|off|status|mode>\n\n` +
    `${italic('Modes:')}\n${SECURITY_MODE_USAGE}\n\n` +
    `Examples:\n` +
    `  ${prefix}antidemote on\n` +
    `  ${prefix}antidemote mode revert\n` +
    `  ${prefix}antidemote off`
  );
}

// ── Anti System Status Overview ───────────────────────────────

export function handleAntiStatus(
  telegramId: string,
  sessionId: string,
  groupJid: string
): string {
  if (!groupJid.endsWith('@g.us')) {
    return errorCard('Anti System', 'This command must be used inside a WhatsApp group.');
  }
  const gc = loadGroupAntiConfig(telegramId, sessionId, groupJid);
  const modules: [string, string][] = [
    ['AntiLink', gc.antilink?.enabled ? `✅ ${gc.antilink.action}` : '❌ off'],
    ['AntiBot', gc.antibot?.enabled ? `✅ ${gc.antibot.action}` : '❌ off'],
    ['AntiSpam', gc.antispam?.enabled ? `✅ ${gc.antispam.action} (${gc.antispam.messageLimit}msg/${gc.antispam.windowSeconds}s)` : '❌ off'],
    ['AntiPic', gc.antipic?.enabled ? `✅ ${gc.antipic.action}` : '❌ off'],
    ['AntiVid', gc.antivid?.enabled ? `✅ ${gc.antivid.action}` : '❌ off'],
    ['AntiAud', gc.antiaud?.enabled ? `✅ ${gc.antiaud.action}` : '❌ off'],
    ['AntiVN', gc.antivn?.enabled ? `✅ ${gc.antivn.action}` : '❌ off'],
    ['AntiText', gc.antitxt?.enabled ? `✅ ${gc.antitxt.action}` : '❌ off'],
    ['AntiEmoji', gc.antiemoji?.enabled ? `✅ ${gc.antiemoji.action}` : '❌ off'],
    ['AntiSticker', gc.antisticker?.enabled ? `✅ ${gc.antisticker.action}` : '❌ off'],
    ['AntiGroupCall', gc.antigroupcall?.enabled ? `✅ ${gc.antigroupcall.action}` : '❌ off'],
    ['AntiNSFW', gc.antinsfw?.enabled ? `✅ ${gc.antinsfw.action}` : '❌ off'],
    ['AntiGroupMention', gc.antigroupmention?.enabled ? `✅ ${gc.antigroupmention.action}` : '❌ off'],
    ['AntiGM', gc.antigm?.enabled ? `✅ ${gc.antigm.action}` : '❌ off'],
    ['AntiWords', gc.antiwords?.enabled ? `✅ ${gc.antiwords.action} (${gc.antiwords.words.length} words)` : '❌ off'],
    ['AntiPoll', gc.antipoll?.enabled ? `✅ ${gc.antipoll.action}` : '❌ off'],
    ['AntiForward', gc.antiforward?.enabled ? `✅ ${gc.antiforward.action}` : '❌ off'],
    ['AntiChannel', gc.antichannel?.enabled ? `✅ ${gc.antichannel.action}` : '❌ off'],
    ['AntiPromote', gc.antipromote?.enabled ? `✅ mode:${(gc.antipromote as AntiPromoteConfig | undefined)?.mode ?? gc.antipromote.action}` : '❌ off'],
    ['AntiDemote', gc.antidemote?.enabled ? `✅ mode:${gc.antidemote.mode}` : '❌ off'],
  ];
  return asciiBox({
    title: 'Anti System Status',
    emoji: '🛡️',
    rows: modules,
    footer: `Group: ${groupJid.split('@')[0]}`,
  });
}

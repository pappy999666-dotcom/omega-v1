// ============================================================
// WA-Bridge — Help Engine
// The WhatsApp help path is command inspection, not menu pagination.
// MENU_CATALOG remains the single source of command documentation.
// ============================================================

import { MENU_CATALOG, helpPageText, type MenuEntry } from '../whatsapp/menu-registry.js';
import { H, header, escape } from '../utils/formatter.js';

function buildHelpIntro(prefix: string): string {
  return [
    '𝗛𝗘𝗟𝗣 𝗘𝗡𝗚𝗜𝗡𝗘',
    '',
    'Type:',
    '',
    `${prefix}help <command>`,
    '',
    'Example:',
    '',
    `${prefix}help pair`,
    '',
    'Use this command to inspect how a specific command works.',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

export function commandHelpEntry(commandName: string): MenuEntry | undefined {
  const normalized = commandName.trim().toLowerCase();
  const direct = MENU_CATALOG[normalized];
  if (direct) return direct;
  const aliasOwner = Object.values(MENU_CATALOG).find((entry) =>
    entry.aliases?.some((alias) => alias.toLowerCase() === normalized)
  );
  return aliasOwner;
}

export function helpIntroText(prefix = '.'): string {
  return buildHelpIntro(prefix);
}

function formatExamples(prefix: string, examples: string[] | undefined): string[] {
  return (examples ?? []).map((example) => {
    const trimmed = example.trim();
    return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`;
  });
}

/** Render one command's complete registry metadata. */
export function generateWhatsAppHelp(
  prefix: string,
  _isGroup: boolean,
  commandName?: string,
  knownCommands: readonly string[] = []
): string {
  if (!commandName) return buildHelpIntro(prefix);

  const name = commandName.trim().toLowerCase();
  const entry = commandHelpEntry(name);
  const registeredAlias = entry?.aliases?.some((alias) => alias.toLowerCase() === name) ?? false;
  if (!entry || (knownCommands.length > 0 && !knownCommands.includes(name) && !registeredAlias)) {
    return [
      '❌ 𝗖𝗼𝗺𝗺𝗮𝗻𝗱 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱',
      `└ Command: ${name || '—'}`,
      '└ Reason: This command is not registered.',
      `└ Try: ${prefix}help or ${prefix}help <command>`,
    ].join('\n');
  }

  const lines = [
    '╭─── ⟡ 𝗖𝗢𝗠𝗠𝗔𝗡𝗗 𝗛𝗘𝗟𝗣 ⟡ ───╮',
    '',
    `𝗖𝗼𝗺𝗺𝗮𝗻𝗱 : ${name}`,
    '',
    '𝗗𝗲𝘀𝗰𝗿𝗶𝗽𝘁𝗶𝗼𝗻',
    entry.desc,
    '',
    '𝗨𝘀𝗮𝗴𝗲',
    `${prefix}${entry.syntax}`,
  ];

  if (entry.inputs?.length || entry.args) {
    lines.push('', '𝗣𝗮𝗿𝗮𝗺𝗲𝘁𝗲𝗿𝘀', entry.args ?? entry.inputs!.join(', '));
  }
  const examples = formatExamples(prefix, entry.examples);
  if (examples.length) lines.push('', '𝗘𝘅𝗮𝗺𝗽𝗹𝗲𝘀', ...examples);
  if (entry.aliases?.length) lines.push('', '𝗔𝗹𝗶𝗮𝘀𝗲𝘀', entry.aliases.join(', '));
  lines.push('', '𝗣𝗲𝗿𝗺𝗶𝘀𝘀𝗶𝗼𝗻', entry.permissions ?? 'Public');
  if (entry.notes?.length) lines.push('', '𝗜𝗺𝗽𝗼𝗿𝘁𝗮𝗻𝘁 𝗡𝗼𝘁𝗲𝘀', ...entry.notes.map((note) => `• ${note}`));
  if (entry.output) lines.push('', '𝗢𝘂𝘁𝗽𝘂𝘁', entry.output);
  lines.push('', '╰── 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ──╯');
  return lines.join('\n');
}

// Telegram retains its category-oriented presentation; it shares the same
// registry metadata but does not use the WhatsApp dashboard contract.
export function generateTelegramHelp(_isOwner: boolean): string {
  return [
    header('OMEGA HELP', '📖'),
    '',
    'Welcome to the official command guide. Tap a category below to see detailed syntax.',
    '',
    H.italic('Note: Telegram commands use / prefix, while WhatsApp uses . by default.'),
  ].join('\n');
}

export function generateTelegramCategoryHelp(category: string): string {
  const entries = Object.entries(MENU_CATALOG)
    .filter(([, entry]) => entry.section.toLowerCase().includes(category.toLowerCase()) && !entry.hidden);
  if (entries.length === 0) return 'No commands found in this category.';
  return [
    header(entries[0]![1].section, '◈'),
    '',
    ...entries.map(([cmd, entry]) => `${H.bold('/' + cmd)}\n${H.code(entry.syntax)}\n${escape(entry.desc)}\n`),
  ].join('\n');
}

/** Compatibility wrapper for old callers. Help no longer paginates on WhatsApp. */
export function generateWhatsAppHelpPage(
  prefix: string,
  _isGroup: boolean,
  _page: number,
  _knownCommands: readonly string[] = []
): { text: string; totalPages: number } {
  return { text: buildHelpIntro(prefix), totalPages: 1 };
}

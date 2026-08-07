// ============================================================
// WA-Bridge — Help Auto-generator
// Platform-aware command documentation
// ============================================================

import { MENU_CATALOG, helpPageText } from '../whatsapp/menu-registry.js';
import { H, header, escape } from '../utils/formatter.js';
import { asciiBox, italic } from '../utils/ascii-art.js';

export function generateTelegramHelp(isOwner: boolean): string {
  const sections: Record<string, string[]> = {};

  for (const [cmd, entry] of Object.entries(MENU_CATALOG)) {
    if (entry.hidden) continue;
    if (!sections[entry.section]) sections[entry.section] = [];
    sections[entry.section].push(`${H.bold('/' + cmd)} — ${escape(entry.desc)}`);
  }

  const text = [
    header('OMEGA HELP', '📖'),
    '',
    'Welcome to the official command guide. Tap a category below to see detailed syntax.',
    '',
    H.italic('Note: Telegram commands use / prefix, while WhatsApp uses . by default.'),
  ].join('\n');

  return text;
}

export function generateTelegramCategoryHelp(category: string): string {
  const entries = Object.entries(MENU_CATALOG).filter(([_, e]) => e.section.toLowerCase().includes(category.toLowerCase()) && !e.hidden);
  
  if (entries.length === 0) return 'No commands found in this category.';

  const sectionName = entries[0]![1].section;
  const text = [
    header(sectionName, '◈'),
    '',
    ...entries.map(([cmd, e]) => `${H.bold('/' + cmd)}\n${H.code(e.syntax)}\n${escape(e.desc)}\n`),
  ].join('\n');

  return text;
}

export function generateWhatsAppHelp(prefix: string, isGroup: boolean, commandName?: string): string {
  if (commandName) {
    const entry = MENU_CATALOG[commandName.toLowerCase()];
    if (entry && !entry.hidden) {
      const rows: [string, string][] = [
        ['Syntax', `\`\`\`${prefix}${entry.syntax}\`\`\``],
        ['Description', entry.desc],
      ];
      if (entry.usage) rows.push(['Usage', entry.usage]);
      if (entry.permissions) rows.push(['Permissions', entry.permissions]);
      if (entry.inputs && entry.inputs.length > 0) rows.push(['Supports', entry.inputs.join(', ')]);
      if (entry.args) rows.push(['Arguments', entry.args]);
      if (entry.output) rows.push(['Output', entry.output]);
      if (entry.examples && entry.examples.length > 0) {
        rows.push(['Examples', entry.examples.map(ex => `${prefix}${ex}`).join('\n')]);
      }

      return asciiBox({
        title: `COMMAND: ${commandName.toUpperCase()}`,
        emoji: '⚔',
        moduleIdentity: entry.section,
        rows,
        footer: 'Type .menu for full command list.'
      });
    }
  }

  // Registry-driven plain-text help. The full command list is paginated;
  // navigation is done by sending `.help 2`, `.help 3`, and so on.
  return helpPageText(prefix, 1, 'all', []).text;
}

/** Paginated help page n — used by .help <n> and the native-flow Help buttons. */
export function generateWhatsAppHelpPage(
  prefix: string,
  isGroup: boolean,
  page: number,
  knownCommands: readonly string[] = []
): { text: string; totalPages: number } {
  return helpPageText(prefix, page, 'all', knownCommands);
}

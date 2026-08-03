// ============================================================
// WA-Bridge — Release Notes Generator
// Automatically detects changes and formats changelogs
// ============================================================

import { execSync } from 'child_process';
import { header, H, escape } from './formatter.js';

export interface ReleaseInfo {
  version: string;
  prevCommit: string;
  currCommit: string;
  added: string[];
  improved: string[];
  fixed: string[];
  commandsAdded: string[];
  commandsUpdated: string[];
  commandsRemoved: string[];
}

export async function generateReleaseNotes(prevCommit: string, currCommit: string): Promise<string> {
  const version = execSync('node -p "require(\'./package.json\').version"', { encoding: 'utf8' }).trim();
  const date = new Date().toLocaleString();

  // Get commit messages between prev and curr
  const logs = execSync(`git log ${prevCommit}..${currCommit} --pretty=format:"%s"`, { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  const added: string[] = [];
  const improved: string[] = [];
  const fixed: string[] = [];

  for (const log of logs) {
    if (log.toLowerCase().startsWith('feat') || log.toLowerCase().startsWith('add')) added.push(log);
    else if (log.toLowerCase().startsWith('fix')) fixed.push(log);
    else improved.push(log);
  }

  // Detect command changes by comparing menu-registry.ts or similar
  // For now, we'll use a placeholder or parse the diff
  const commandsAdded: string[] = [];
  const commandsUpdated: string[] = [];
  const commandsRemoved: string[] = [];

  const text = [
    '━━━━━━━━━━━━━━━━━━',
    '🚀 <b>PAPPY UPDATE</b>',
    '━━━━━━━━━━━━━━━━━━',
    '',
    `📌 <b>Version:</b> ${version}`,
    `📅 <b>Date:</b> ${date}`,
    '',
    added.length > 0 ? `✨ <b>New Features</b>\n${added.map(l => `• ${escape(l)}`).join('\n')}\n` : '',
    improved.length > 0 ? `🛠 <b>Improvements</b>\n${improved.map(l => `• ${escape(l)}`).join('\n')}\n` : '',
    fixed.length > 0 ? `🐞 <b>Bug Fixes</b>\n${fixed.map(l => `• ${escape(l)}`).join('\n')}\n` : '',
    '',
    commandsAdded.length > 0 ? `📦 <b>Commands Added:</b> ${commandsAdded.join(', ')}` : '',
    commandsUpdated.length > 0 ? `♻ <b>Commands Updated:</b> ${commandsUpdated.join(', ')}` : '',
    commandsRemoved.length > 0 ? `🗑 <b>Commands Removed:</b> ${commandsRemoved.join(', ')}` : '',
    '',
    '━━━━━━━━━━━━━━━━━━',
  ].filter(l => l !== '').join('\n');

  return text;
}

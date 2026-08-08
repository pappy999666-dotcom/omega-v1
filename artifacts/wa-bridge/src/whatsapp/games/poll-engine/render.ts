// ============================================================
// Poll Game Engine — OMEGA Renderers
// ============================================================

import type { NativeTableContent } from '../../utils/native-rich.js';
import type { PollGameState, PollQuestion } from './types.js';
import { RANK_MEDALS, mentionToken } from './engine.js';

const OMEGA_FOOTER = '· · ——— 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ——— · ·';
const BOLD: Record<string, string> = {
  A: '𝗔', B: '𝗕', C: '𝗖', D: '𝗗', E: '𝗘', F: '𝗙', G: '𝗚', H: '𝗛', I: '𝗜', J: '𝗝', K: '𝗞', L: '𝗟', M: '𝗠', N: '𝗡', O: '𝗢', P: '𝗣', Q: '𝗤', R: '𝗥', S: '𝗦', T: '𝗧', U: '𝗨', V: '𝗩', W: '𝗪', X: '𝗫', Y: '𝗬', Z: '𝗭',
};

export function spacedTitle(text: string): string {
  return text.toUpperCase().split('').map((ch) => BOLD[ch] ?? ch).join(' ').replace(/ {2,}/g, '  ').trim();
}
export function wyrTitle(): string { return spacedTitle('Would You Rather'); }
export function quizTitle(): string { return spacedTitle('Quiz'); }

export function formatDuration(ms: number): string {
  if (ms >= 3_600_000) { const h = ms / 3_600_000; return `${Number.isInteger(h) ? h : h.toFixed(1)}h`; }
  if (ms >= 60_000) { const m = ms / 60_000; return `${Number.isInteger(m) ? m : m.toFixed(1)}min`; }
  return `${Math.round(ms / 1000)}s`;
}

function optionLines(question: PollQuestion): string[] {
  return question.options.map((opt, i) => `  ${String.fromCharCode(65 + i)}) ${opt}`);
}

export function renderWyrHeader(question: PollQuestion, now: number): string {
  const remaining = Math.max(question.expiresAt - now, 0);
  return [wyrTitle(), '', `✦ Question : ${question.prompt}`, ...optionLines(question), '', `⏱ Voting closes in ${formatDuration(remaining)} — vote in the poll above!`, '', OMEGA_FOOTER].join('\n');
}

export function renderWyrResult(game: PollGameState, question: PollQuestion): { text: string; mentions: string[]; table: NativeTableContent; fallback: string } {
  const perOption: Record<number, string[]> = {};
  for (const [voter, optionIndex] of Object.entries(question.votes)) (perOption[optionIndex] ??= []).push(voter);
  const ranked = Object.keys(perOption).map(Number).filter((idx) => idx >= 0 && idx < question.options.length).sort((a, b) => (perOption[b]?.length ?? 0) - (perOption[a]?.length ?? 0));
  const allVoters = Object.keys(question.votes).filter((v) => v.includes('@s.whatsapp.net'));
  const lines = [`${wyrTitle()} — 🏆 RESULTS`, '', `✦ Question : ${question.prompt}`, ''];
  const rows: (string | number)[][] = [['Rank', 'Choice', 'Votes']];
  const fallbackRows: string[] = [];
  ranked.forEach((idx, rankPos) => {
    const medal = RANK_MEDALS[rankPos] ?? `${rankPos + 1}.`;
    const voters = perOption[idx] ?? [];
    const label = `${String.fromCharCode(65 + idx)}) ${question.options[idx]}`;
    rows.push([medal, label, String(voters.length)]);
    fallbackRows.push(`${medal} ${label} — ${voters.length} vote${voters.length === 1 ? '' : 's'}`);
    lines.push(`${medal} ${label} — ${voters.length} vote${voters.length === 1 ? '' : 's'}`);
    if (voters.length > 0) lines.push(`   ${voters.map(mentionToken).join(' ')}`);
  });
  if (ranked.length === 0) { lines.push('😴 No votes were cast.'); rows.push(['—', 'No votes', '0']); fallbackRows.push('😴 No votes were cast.'); }
  lines.push('', OMEGA_FOOTER);
  return { text: lines.join('\n'), mentions: allVoters, table: { title: '🏆 WYR RESULTS', rows }, fallback: fallbackRows.join('\n') };
}

/** WYR's score is participation, never correctness: one point per valid vote. */
export function renderWyrFinal(game: PollGameState): { text: string; mentions: string[]; table: NativeTableContent; fallback: string } {
  const ranked = Object.values(game.players).filter((p) => p.jid.includes('@s.whatsapp.net')).sort((a, b) => b.score - a.score || a.jid.localeCompare(b.jid));
  const rows: (string | number)[][] = [['Rank', 'Player', 'Participation']];
  const fallback: string[] = [];
  const mentions: string[] = [];
  ranked.slice(0, 10).forEach((player, index) => {
    const medal = RANK_MEDALS[index] ?? `${index + 1}.`;
    const label = mentionToken(player.jid);
    rows.push([medal, label, String(player.score)]);
    fallback.push(`${medal} ${label} — ${player.score} vote${player.score === 1 ? '' : 's'} recorded`);
    mentions.push(player.jid);
  });
  const text = [`${wyrTitle()} — 🏆 FINAL PARTICIPATION`, '', ...(ranked.length ? fallback : ['No players participated.']), '', OMEGA_FOOTER].join('\n');
  return { text, mentions, table: { title: '🏆 WYR FINAL PARTICIPATION', rows }, fallback: fallback.join('\n') || 'No players participated.' };
}

export function renderQuizHeader(game: PollGameState, question: PollQuestion, now: number, total: number): string {
  const number = game.questions.indexOf(question) + 1;
  const remaining = Math.max(question.expiresAt - now, 0);
  const meta = [question.category, question.difficulty].filter(Boolean).join(' · ');
  return [`${quizTitle()} 𝄜 𝗤𝗨𝗘𝗦𝗧𝗜𝗢𝗡 ${number}/${total}`, ...(meta ? ['', `📍 ${meta}`] : []), '', `✦ Question : ${question.prompt}`, ...optionLines(question), '', `⏱ ${formatDuration(remaining)} to answer — vote in the poll above!`, '', OMEGA_FOOTER].join('\n');
}

export function renderQuizReveal(game: PollGameState, question: PollQuestion, correctVoters: string[], _now: number): string {
  const number = game.questions.indexOf(question) + 1;
  const lines = [`${quizTitle()} 𝄜 𝗔𝗡𝗦𝗪𝗘𝗥 — Q${number}`, '', `✅ Correct : ${String.fromCharCode(65 + (question.correctIndex ?? 0))}) ${question.options[question.correctIndex ?? 0] ?? '—'}`];
  if (question.explanation) lines.push(`📖 ${question.explanation}`);
  if (correctVoters.length > 0) lines.push('', `➕ +1 point: ${correctVoters.map(mentionToken).join(' ')}`);
  lines.push('', OMEGA_FOOTER);
  return lines.join('\n');
}

export function renderQuizLeaderboard(game: PollGameState): { table: NativeTableContent; fallback: string; text: string; mentions: string[] } {
  const ranked = Object.values(game.players).filter((p) => p.jid.includes('@s.whatsapp.net')).sort((a, b) => b.score - a.score || a.jid.localeCompare(b.jid)).slice(0, 5);
  const rows: (string | number)[][] = [['Rank', 'Player', 'Score']];
  const fallback: string[] = [];
  const mentions: string[] = [];
  ranked.forEach((p, i) => { const medal = RANK_MEDALS[i] ?? `${i + 1}.`; const label = mentionToken(p.jid); rows.push([medal, label, String(p.score)]); fallback.push(`${medal} ${label} — ${p.score} pt${p.score === 1 ? '' : 's'}`); mentions.push(p.jid); });
  const text = [`${quizTitle()} 𝄜 𝗟𝗘𝗔𝗗𝗘𝗥𝗕𝗢𝗔𝗥𝗗`, '', ...(ranked.length ? fallback : ['No players yet.']), '', OMEGA_FOOTER].join('\n');
  return { table: { title: '🏆 QUIZ LEADERBOARD', rows }, fallback: fallback.join('\n') || 'No players yet.', text, mentions };
}

export function renderQuizFinal(game: PollGameState): { text: string; mentions: string[]; table: NativeTableContent; fallback: string } {
  const ranked = Object.values(game.players).filter((p) => p.jid.includes('@s.whatsapp.net')).sort((a, b) => b.score - a.score || a.jid.localeCompare(b.jid));
  const winner = ranked[0];
  const rows: (string | number)[][] = [['Rank', 'Player', 'Score']];
  const fallback: string[] = [];
  const mentions: string[] = [];
  ranked.slice(0, 10).forEach((p, i) => { const medal = RANK_MEDALS[i] ?? `${i + 1}.`; const label = mentionToken(p.jid); rows.push([medal, label, String(p.score)]); fallback.push(`${medal} ${label} — ${p.score} pt${p.score === 1 ? '' : 's'}`); mentions.push(p.jid); });
  const text = [`${quizTitle()} 𝄜 𝗙𝗜𝗡𝗔𝗟 𝗥𝗘𝗦𝗨𝗟𝗧`, '', winner ? `🏆 Winner: ${mentionToken(winner.jid)}` : 'No players participated.', '', ...fallback, '', OMEGA_FOOTER].join('\n');
  return { text, mentions, table: { title: '🏆 QUIZ FINAL RESULT', rows }, fallback: fallback.join('\n') || 'No players.' };
}

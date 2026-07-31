// ============================================================
// WA-Bridge — Omega Status Remix Engine
// Grammar-driven Unicode status generator with large remix space
// Compact, WhatsApp-native, and designed to avoid template repetition
// ============================================================

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

export const STATUS_THEMES = [
  'kawaii', 'sakura', 'japanese', 'cyber', 'minimal', 'luxury',
  'dreamcore', 'angelcore', 'gothic', 'soft', 'cloud', 'moon',
  'ribbon', 'pixel', 'flower', 'stars', 'hearts',
  'girly', 'guys', 'yami', 'vampire', 'angel', 'webcore',
  'dark', 'prestige', 'y2k', 'brat', 'clean',
] as const;

export type StatusTheme = (typeof STATUS_THEMES)[number];

export interface StatusDesignInput {
  theme?: string;
  url: string;
  title?: string;
  message?: string;

  /**
   * Optional deterministic seed.
   * When omitted, the engine uses time + randomness so each render can remix.
   */
  seed?: string;

  /**
   * Higher values increase layout variety and decorative density.
   * 1 = conservative, 2 = balanced, 3 = wild.
   */
  remixLevel?: 1 | 2 | 3;
}

export interface StatusDesignResult {
  theme: StatusTheme;
  text: string;
  url: string;
  recipe: string;
  remixKey: string;
}

type ThemeFamily =
  | 'floral'
  | 'lunar'
  | 'ethereal'
  | 'tech'
  | 'luxury'
  | 'cute'
  | 'cloud'
  | 'pixel'
  | 'stars'
  | 'minimal'
  | 'japanese';

interface FamilyPools {
  headers: readonly string[];
  footers: readonly string[];
  dividers: readonly string[];
  ornaments: readonly string[];
  titleFrames: ReadonlyArray<readonly [string, string]>;
  moods: readonly string[];
}

const THEME_TO_FAMILY: Record<StatusTheme, ThemeFamily> = {
  kawaii: 'cute',
  sakura: 'floral',
  flower: 'floral',
  moon: 'lunar',
  gothic: 'lunar',
  vampire: 'lunar',
  dreamcore: 'ethereal',
  angelcore: 'ethereal',
  soft: 'ethereal',
  cyber: 'tech',
  webcore: 'tech',
  dark: 'tech',
  luxury: 'luxury',
  prestige: 'luxury',
  ribbon: 'cute',
  hearts: 'cute',
  y2k: 'cute',
  brat: 'cute',
  cloud: 'cloud',
  pixel: 'pixel',
  stars: 'stars',
  minimal: 'minimal',
  clean: 'minimal',
  japanese: 'japanese',
  girly: 'floral',
  guys: 'cute',
  yami: 'lunar',
  angel: 'ethereal',
};

const FAMILY_POOLS: Record<ThemeFamily, FamilyPools> = {
  floral: {
    headers: [
      '✿・°。・✿', '❀════❀', '✿°｡・°✿', '꒰🌸꒱', '🌸⸝⸝🌸', '✿ · ✿ · ✿',
      '❀・✿・❀', '🌸・°。🌸', '✿｡✿', '꒷꒦꒷꒦꒷', '·˚ ༘ ✿', '˚₊‧꒰🌸꒱‧₊˚',
      '✾ · ✾', '🌺・🌸・🌺', '⸝⸝ ✿ ⸝⸝', '✿ ゜ ✿', '꒰ ✿ ꒱',
      '꒰ঌ ✿ ໒꒱', '˗ˏˋ ✿ ˊˎ˗', '⊹ ✿ ⊹', '✿ · ❀ · ✿',
      '🌸 · · · 🌸', '❀ ─ · ─ · ─ ❀', '꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦',
    ],
    dividers: [
      '╎ ╎ ╎', '❁────────❁', '✿┄┄┄✿', '⋆｡˚✿˚｡⋆', '♡──✿──♡', '❀⋅❀⋅❀',
      '· · ─ ─ · · ─ ─ · · ─ ─ · ·', '❀ ─ · ─ · ─ · ─ · ─ · ─ ❀',
      ' ୨─────────────────୧', '˚✧₊⁺ · · · · · · · · ⁺₊✧˚',
      '🌸 · 🌸 · 🌸 · 🌸 · 🌸 · 🌸', '✦ · · ◌ · · ✦ · · ◌ · · ✦',
    ],
    ornaments: ['🌸', '✿', '❀', '🌷', '💮', '🍓', '🩷', 'ꕤ', '꒷', '༘', '୨୧'],
    titleFrames: [
      ['♡', '♡'], ['✿', '✿'], ['❀', '❀'], ['꒰', '꒱'], ['🌸', '🌸'],
      ['⸝⸝', '⸝⸝'], ['˚', '˚'], ['·', '·'], ['〜', '〜'], ['⌒', '⌒'],
      ['｢', '｣'], ['✾', '✾'],
    ],
    footers: [
      '♡ Join Us ♡', '✿ See You Inside ✿', '❀ Open Link ❀',
      '˚₊ · ͟͟͞͞꒰ Tap to Join ꒱', '✿ Click Here ✿', '🌸 Welcome 🌸',
      '꒰ Meet New Friends ꒱', '✿ Enter ✿', '❀ Visit Now ❀',
      '·˚ ♡ Enjoy ♡ ˚·', '✿・・✿', '🌸 Stay Cute 🌸',
      'tap before it closes ♡', 'bloom with us ✿', 'petal in 🌸',
      'don\'t miss it ❀', 'flutter in ♡', 'while it lasts 💫',
    ],
    moods: ['soft floral', 'sakura bloom', 'petal glow', 'spring pastel'],
  },

  lunar: {
    headers: [
      '☾⋆｡', '☾ · ☽', '⋆｡☽', '☾━━━☽', '† ☾ †', '♱ · ♱',
      '☾⋆·˚', '⋆ ☾ ⋆', '☽｡⋆', '☾ ⸻ ☽', '·͜· ☾ ·͜·', '🌙 · 🌙', '☾ · · · ☽',
      '✝ ─ ☽ ─ ✝', '⛧ · · · · · · · · · · · ⛧',
      '☽ · ☽ · ☽ · ☽ · ☽ · ☽ · ☽', '🌑 · · · · · · · · · · · 🌑',
      '🦇 · · · · · · · · · · 🦇', '🥀 · · · · · · · · · · · 🥀',
    ],
    dividers: [
      '☾────☽', '⋆˚☆˚⋆', '☽⋅☾⋅☽', '†━━━━━━━━†', '✦──✦──✦',
      '✝ ─ ✝ ─ ✝ ─ ✝ ─ ✝ ─ ✝ ─ ✝', '☽ · ─ · ☾',
      '💀 · · · · · · · · · 💀', '🕯 ─ 🕯 ─ 🕯 ─ 🕯 ─ 🕯',
      '░░░░░░░░░░░░░░░░░░░', '▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒',
    ],
    ornaments: ['☾', '☽', '🌙', '✦', '†', '♱', '⋆', '✧', '☾⋆', '✩'],
    titleFrames: [
      ['☾', '☽'], ['†', '†'], ['♱', '♱'], ['⋆', '⋆'], ['「', '」'],
      ['◆', '◆'], ['『', '』'], ['⌞', '⌝'], ['·', '·'], ['‹', '›'],
    ],
    footers: [
      '☾ Welcome ☽', '† Enter ✦', '⋆｡ Step Inside ｡⋆',
      '☾ After Dark ☽', '✦ Midnight ✦', '† Join the Night †',
      '☽ Enter the Gate ☾', '⋆ Come In ⋆', '☾ Open ☽',
      'enter the dark', 'walk the night', 'shadows guide you',
      'the abyss awaits', 'eternal night entry', 'descend willingly',
    ],
    moods: ['moonlit', 'midnight', 'nocturne', 'shadow velvet'],
  },

  ethereal: {
    headers: [
      '✧･ﾟ: *✧･ﾟ:*', '⊹₊ ⋆', '✧ ゜ ✧', '⟡ · ⟡', '˚ · ˚', '⋆｡°✩',
      '✦ ✧ ✦', '· ⋆ ·', '˚₊‧⁺', '⁺˚⋆', '✧ · ✧ · ✧', '゜゚・。⊹', '⟡ ゜ ⟡', '✩ · ✩',
      '˚₊· ͟͟͞͞꒷', '⊹ · ⊹', '✦ ⋆ ✦',
    ],
    dividers: ['⋆⟡⋆⟡⋆', '˚₊‧✧‧₊˚', '✦────✦', '⟡⋅⟡⋅⟡', '𓂃✧𓂃', '✩──✩──✩'],
    ornaments: ['✧', '✦', '✩', '⟡', '⋆', '˚', '𓂃', '𓈒', '𓂂', '༄'],
    titleFrames: [
      ['⟡', '⟡'], ['✧', '✧'], ['⋆', '⋆'], ['✦', '✦'], ['˚', '˚'],
      ['⊹', '⊹'], ['·', '·'], ['°', '°'], ['゜', '゜'], ['♡', '♡'],
      ['✩', '✩'],
    ],
    footers: [
      '✧ Enjoy ✧', '⊹ Stay Awesome ⊹', '✦ Access ✦',
      '⟡ Visit ⟡', '˚ Welcome ˚', '✧ Open Link ✧',
      '· Step In ·', '⋆ Enter ⋆', '✩ Join Now ✩',
      '゜ Come Inside ゜',
      'ascend and join ✦', 'enter the light ♡', 'follow the glow ✨',
      'chosen ones enter', 'float up and in', 'guided by grace',
    ],
    moods: ['dreamy glow', 'angel haze', 'soft aura', 'cloudlight'],
  },

  tech: {
    headers: [
      '⌁ ⚡ ⌁', '◈ :: ◈', '⌘ ⌁ ⌘', '⌁━━⌁', '⚡ ◈ ⚡', ':: ⌘ ::',
      '▣ · ▣', '⌘━━⌘', '◈ ⌁ ◈', '⚡⌁⚡', '::▣::', '⌘ · ⌘',
      '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓', '░░░░░░░░░░░░░░░░░░░░',
      '◇━━━━━━━━━━━━━━━━━━◇', '◆──────────────────◆',
      '╠═══════════════════╣', '⊱───────────────────⊰',
      '►────────────────────►', '· ─ · ─ · ─ · ─ · ─',
    ],
    dividers: [
      '▣━━━━▣', '⌁───⌁───⌁', '◈·◈·◈', '⚡═⚡═⚡', '⌘────⌘',
      '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓', '░░░░░░░░░░░░░░░░░░░░',
      '▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒', '━━━━━━━━━━━━━━━━━━━━',
      '════════════════════', '╠═══════════════════╣',
      '◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈', '⟫─────────────────⟪',
    ],
    ornaments: ['⚡', '◈', '⌘', '⌁', '▣', '■', '◆', '⌬', '⌖'],
    titleFrames: [
      ['⌞', '⌝'], ['◈', '◈'], ['⌘', '⌘'], ['⟦', '⟧'], ['[', ']'],
      ['::', '::'], ['◆', '◆'], ['▣', '▣'], ['⌁', '⌁'], ['‹', '›'],
    ],
    footers: [
      '◈ Access Granted ◈', '⌘ Execute ⌘', '⚡ Connect ⚡',
      ':: Open Link ::', '▣ Enter System ▣', '⌁ Join Now ⌁',
      '◈ Tap In ◈', '⌘ Login ⌘',
      'ACCESS GRANTED ↵', 'DECODE BEFORE TIMEOUT', 'SYNC OR MISS OUT',
      'TAP IN. CLOCK IS TICKING.', 'CONNECT TO THE GRID', 'EXECUTE BEFORE PATCH',
      'ENTER WHILE YOU CAN', 'NO NOISE. JUST ENTRY.', 'KEY BURNS AFTER USE',
    ],
    moods: ['neon grid', 'digital pulse', 'system glow', 'cyber static'],
  },

  luxury: {
    headers: [
      '♛ ✦ ♛', '◆ ✨ ◆', '✦ ♛ ✦', '❖ · ❖', '♛━━♛', '◆ · ◆',
      '✦ ◆ ✦', '❖ ✦ ❖', '♛ · ✦ · ♛', '◆━━━◆', '✦✦✦',
      '⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡', '◈ · · · · · · · · · · · ◈',
      '◆─────────────────◆', '◇━━━━━━━━━━━━━━━━━━◇',
      '💎 · · · · · · · · · · 💎', '👑 ─ 👑 ─ 👑 ─ 👑 ─ 👑',
    ],
    dividers: [
      '✦────✦', '◆⋅◆⋅◆', '❖━━❖━━❖', '♛═♛═♛', '✨✦✨',
      '⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡', '◈ · · · · · · · · · · · ◈',
      '◆─────────────────◆', '◇━━━━━━━━━━━━━━━━━━◇',
      '💎 · · · · · · · · · · 💎', '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
    ],
    ornaments: ['♛', '✦', '◆', '❖', '✨', '⬖', '⬗', '✧', '⟡'],
    titleFrames: [
      ['♛', '♛'], ['✦', '✦'], ['◆', '◆'], ['❖', '❖'], ['✨', '✨'],
      ['‹', '›'], ['「', '」'], ['⌞', '⌝'], ['·', '·'],
    ],
    footers: [
      '♛ Verified Access ♛', '✦ Private Link ✦', '◆ Select Members ◆',
      '❖ Enter ❖', '✨ Premium ✨', '♛ Join Now ♛',
      '◆ Exclusive ◆', '✦ Welcome ✦',
      'no noise. just entry.', 'prestige granted', 'elite confirmed',
      'access approved', 'distinction awarded', 'set apart. enter.',
      'curated entry', 'the bar is raised', 'worth confirmed',
    ],
    moods: ['premium velvet', 'royal gloss', 'golden aura', 'elite shine'],
  },

  cute: {
    headers: [
      '╭─ 🎀 ─╮', '♡━━━♡', '🎀 · 🎀', '⌈✦⌋', '✶ · ✶', '💗 · 💗',
      '╭──♡──╮', '🎀・🎀', '♡ · ♡ · ♡', '✶✶✶', '💕 · 💕', '🎀 ─ 🎀',
      '꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦', '✨ · · ✨ · · ✨ · · ✨ · · ✨',
      '🌸 · 🌸 · 🌸 · 🌸 · 🌸 · 🌸', '💕 · · · · · · · · · · · 💕',
      '♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡', '🎀 · · · · · · · · · · 🎀',
      '˚ · . · ˚ · . · ˚ · . · ˚', '° ˖ · ° ˖ · ° ˖ · ° ˖ · °',
    ],
    dividers: [
      '♡──♡──♡', '🎀⋅🎀⋅🎀', '✶━✶━✶', '💗────────💗', '꒰♡꒱',
      '꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦', '✨ · · ✨ · · ✨ · · ✨ · · ✨',
      '🌸 · 🌸 · 🌸 · 🌸 · 🌸 · 🌸', '💕 · · · · · · · · · · · 💕',
      '♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡', '⊱ ──────────────── ⊰',
      '˚ · . · ˚ · . · ˚ · . · ˚', '~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
    ],
    ornaments: ['🎀', '♡', '💗', '✶', '💕', '🍓', '🧸', '🩷', '🌸', '🐇'],
    titleFrames: [
      ['🎀', '🎀'], ['♡', '♡'], ['💗', '💗'], ['✶', '✶'], ['·', '·'],
      ['꒰', '꒱'], ['「', '」'], ['⌈', '⌉'], ['✦', '✦'], ['💕', '💕'],
    ],
    footers: [
      '♡ See You Inside ♡', '🎀 Join Us 🎀', '💗 Welcome 💗',
      '✶ Tap to Enter ✶', '꒰ Open Link ꒱', '♡ Meet New Friends ♡',
      '🎀 Say Less 🎀', '💕 Come In 💕', '✶ Join Now ✶',
      'tap tap tap!! ✨', 'come come come!! 🌸', 'hurry hurry ♡',
      'pls pls pls tap!! 💕', 'don\'t miss it nyaaa!!', 'yay come play with us!! 🎀',
      'it\'s so cute inside!! 🌈', 'we\'re waiting uwu ♡', 'omg yes do it!! ✨',
    ],
    moods: ['kawaii pop', 'coquette cute', 'soft pink', 'bubble pastel'],
  },

  cloud: {
    headers: ['☁️ ～ ☁️', '～ ° ～', '☁ · ☁ · ☁', '～～～', '° ☁️ °', '˚ ～ ˚', '☁️ · · · ☁️', '～ ˚ ～'],
    dividers: ['☁────☁', '～⋅～⋅～', '°⋆°⋆°', '☁☁☁', '✧☁✧☁✧'],
    ornaments: ['☁️', '˚', '～', '°', '☁', '✧', '⟡', '𓂃'],
    titleFrames: [['☁️', '☁️'], ['～', '～'], ['°', '°'], ['˚', '˚'], ['·', '·'], ['〜', '〜'], ['❀', '❀']],
    footers: ['☁️ Float In ☁️', '～ Welcome ～', '° Drift Inside °', '˚ Open Link ˚', '☁ Join Now ☁', '～ Enter ～'],
    moods: ['cloudsoft', 'sky drift', 'misty calm', 'float mode'],
  },

  pixel: {
    headers: ['■ ◆ ■', '★ ◆ ★', '▪ ■ ▪', '◆◆◆', '■━■━■', '★ · ★', '▪ ◆ ▪', '■ · ■ · ■'],
    dividers: ['■━■━■', '◆⋅◆⋅◆', '★────★', '▪▪▪', '▰▱▰▱▰'],
    ornaments: ['■', '◆', '★', '▪', '▰', '▱', '▮', '▯'],
    titleFrames: [['■', '■'], ['◆', '◆'], ['★', '★'], ['▪', '▪'], ['▰', '▰'], ['[', ']'], ['‹', '›'], ['·', '·']],
    footers: ['■ Enter ■', '◆ Click ◆', '★ Join ★', '▪ Open ▪', '■ Access ■', '◆ Tap In ◆'],
    moods: ['pixel cute', 'retro blocks', '8-bit glow', 'arcade grid'],
  },

  stars: {
    headers: ['✧ ✦ ✧', '✩ ✦ ✩', '⭐ · ⭐', '✦━━✦', '✧ · ✧ · ✧', '✩ · ✩', '✦ ✧ ✦ ✧ ✦', '⭐ ✦ ⭐', '✧✧✧', '✦ · ✦', '✩━━✩', '☆ ✦ ☆'],
    dividers: ['✧────✧', '✩⋅✩⋅✩', '⭐━⭐━⭐', '✦⋯✦⋯✦', '☆✧☆✧☆'],
    ornaments: ['✧', '✦', '✩', '⭐', '☆', '★', '☾', '☁️', '⟡'],
    titleFrames: [['✧', '✧'], ['✦', '✦'], ['✩', '✩'], ['⭐', '⭐'], ['☆', '☆'], ['★', '★'], ['·', '·'], ['⋆', '⋆']],
    footers: [
      '✦ Join Now ✦', '✧ Shine Inside ✧', '✩ Welcome ✩', '⭐ Open Link ⭐',
      '✦ Enter ✦', '☆ Tap In ☆', '✧ Enjoy ✧', '✩ Access ✩',
      'catch a star ✵', 'follow the light ✦', 'stardust drop',
      'night sparkle entry', 'constellation access', 'shine and enter ✧',
    ],
    moods: ['starshine', 'constellation', 'night sparkle', 'celestial pop'],
  },

  minimal: {
    headers: ['· · ·', '— ○ —', '∙ ∙ ∙', '─────', '· — ·', '○ · ○', '─ · ─', '···', '— · —', '∙∙∙', '○ ─ ○'],
    dividers: ['────────', '· · · · ·', '—○—○—', '───•───', '○────○'],
    ornaments: ['·', '—', '○', '•', '∙', '—', '◦'],
    titleFrames: [['·', '·'], ['—', '—'], ['○', '○'], ['‹', '›'], ['[', ']'], ['(', ')'], ['|', '|'], ['-', '-']],
    footers: [
      '· Open Link ·', '— Join ——', '○ Enter ○', '· Tap In ·',
      '— Welcome —', '∙ Access ∙', 'enter', 'tap in', 'now',
      'join', 'connect', 'proceed', 'step in',
    ],
    moods: ['clean minimal', 'quiet layout', 'simple premium', 'soft monochrome'],
  },

  japanese: {
    headers: ['「◆」', '〜★〜', '・ω・', '「✦」', '〜 ♡ 〜', '「 ✿ 」', '・☆・', '〜✧〜', '「◈」', '。♡。', '・｡・', '〜 ⟡ 〜'],
    dividers: ['───✦───', '〜〜〜〜', '✿・✿・✿', '☆⋅☆⋅☆', '◆━━━━◆'],
    ornaments: ['✿', '✦', '♡', '☆', '◈', '⟡', '｡', '・', '〜'],
    titleFrames: [['「', '」'], ['〔', '〕'], ['【', '】'], ['『', '』'], ['〖', '〗'], ['·', '·'], ['・', '・'], ['♡', '♡'], ['✦', '✦']],
    footers: ['「 ようこそ 」', '〜 Join Us 〜', '・参加する・', '「 Open Link 」', '〜 Welcome 〜', '・Enter・', '「 Tap In 」', '〜 どうぞ 〜'],
    moods: ['japan soft', 'tokyo cute', 'zen pop', 'minimal sakura'],
  },
};

type LayoutId = 'header-title-divider-link-footer';

interface RemixRecipe {
  layout: LayoutId;
  header: string;
  divider?: string;
  footer: string;
  titleLeft: string;
  titleRight: string;
  titleStyle: FontStyle;
  accentCount: number;
}

function hashNumber(seed: string): number {
  return Number.parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12), 16);
}

function choose<T>(items: readonly T[], seed: string, offset: number): T {
  return items[hashNumber(`${seed}:${offset}`) % items.length]!;
}

function coin(seed: string, offset: number, chance = 0.5): boolean {
  return (hashNumber(`${seed}:${offset}`) % 1000) / 1000 < chance;
}

function pickMany<T>(items: readonly T[], seed: string, offset: number, count: number): T[] {
  if (items.length === 0) return [];
  const result: T[] = [];
  const used = new Set<number>();
  let cursor = 0;
  while (result.length < Math.min(count, items.length)) {
    const index = hashNumber(`${seed}:${offset}:${cursor}`) % items.length;
    cursor += 1;
    if (used.has(index)) continue;
    used.add(index);
    result.push(items[index]!);
  }
  return result;
}

function shuffle<T>(items: readonly T[], seed: string): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = hashNumber(`${seed}:${i}`) % (i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function compactSpaces(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function clampTitle(title: string, maxChars = 28): string {
  const cleaned = compactSpaces(title);
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

// ── Unicode font converters ───────────────────────────────

const BOLD_LOWER = '𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇';
const BOLD_UPPER = '𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭';
const SERIF_LOWER = '𝒶𝒷𝒸𝒹𝑒𝒻𝑔𝒽𝒾𝒿𝓀𝓁𝓂𝓃𝑜𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏';
const SERIF_UPPER = '𝒜𝐵𝒞𝒟𝐸𝐹𝒢𝐻𝐼𝒥𝒦𝐿𝑀𝒩𝒪𝒫𝒬𝑅𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵';
const DOUBLE_LOWER = '𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫';
const DOUBLE_UPPER = '𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ';
const GOTHIC_LOWER = '𝖆𝖇𝖈𝖉𝖊𝖋𝖌𝖍𝖎𝖏𝖐𝖑𝖒𝖓𝖔𝖕𝖖𝖗𝖘𝖙𝖚𝖛𝖜𝖝𝖞𝖟';
const GOTHIC_UPPER = '𝕬𝕭𝕮𝕯𝕰𝕱𝕲𝕳𝕴𝕵𝕶𝕷𝕸𝕹𝕺𝕻𝕼𝕽𝕾𝕿𝖀𝖁𝖂𝖃𝖄𝖅';

type FontStyle = 'bold' | 'serif' | 'double' | 'gothic' | 'plain';

function applyFont(text: string, style: FontStyle): string {
  if (style === 'plain') return text.toUpperCase();
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lMap = style === 'bold' ? BOLD_LOWER : style === 'serif' ? SERIF_LOWER : style === 'double' ? DOUBLE_LOWER : GOTHIC_LOWER;
  const uMap = style === 'bold' ? BOLD_UPPER : style === 'serif' ? SERIF_UPPER : style === 'double' ? DOUBLE_UPPER : GOTHIC_UPPER;
  return text.split('').map(c => {
    const li = lower.indexOf(c);
    if (li >= 0) return [...lMap][li] ?? c;
    const ui = upper.indexOf(c.toUpperCase());
    if (ui >= 0 && c === c.toUpperCase() && c !== c.toLowerCase()) return [...uMap][ui] ?? c;
    if (li < 0 && c.toLowerCase() !== c.toUpperCase()) {
      const ui2 = upper.indexOf(c.toUpperCase());
      if (ui2 >= 0) return [...uMap][ui2] ?? c;
    }
    return c;
  }).join('');
}

// ── Subtitle pools per family ─────────────────────────────

const FAMILY_SUBTITLES: Record<ThemeFamily, readonly string[]> = {
  floral:   ['🌸 you\'re invited to something beautiful', '✿ a soft space just for you', '❀ bloom where you belong', '🌷 join the garden', '🩷 petal your way in'],
  lunar:    ['🌙 the night welcomes you', '☾ step into the dark', '† a place beyond the veil', '⋆ midnight calls your name', '🦇 enter if you dare'],
  ethereal: ['✧ a dream you can walk into', '⟡ float above the noise', '˚ your soft place to land', '✦ chosen by the light', '⊹ ascend with us'],
  tech:     ['⚡ system access granted', '◈ encrypted channel open', '⌘ authorized entry only', '▣ signal locked in', ':: connect to the grid'],
  luxury:   ['♛ by invitation only', '✦ select members only', '◆ prestige access granted', '❖ the elite circle awaits', '✨ curated. exclusive. yours.'],
  cute:     ['🎀 the cutest space online', '♡ come vibe with us', '💗 soft & sweet inside', '✶ your new fave group', '💕 besties only uwu'],
  cloud:    ['☁️ float on in', '˚ soft vibes only', '～ drift into the calm', '° a cloud above the rest', '✧ sky-high community'],
  pixel:    ['■ level up and join', '◆ player one enter here', '★ game on inside', '▪ 8-bit vibes await', '▰ press start to join'],
  stars:    ['✦ reach for the stars', '✧ shine with us tonight', '⭐ a constellation of vibes', '✩ stargazers welcome', '☆ the universe is calling'],
  minimal:  ['— a space worth joining', '· clean. simple. real.', '○ no noise. just community.', '• quality over quantity', '— less is more inside'],
  japanese: ['「 ようこそ — welcome 」', '〜 a vibe like no other 〜', '・join the culture・', '「 open to all 」', '〜 step inside 〜'],
};

// ── Tag word pools per family ─────────────────────────────

const FAMILY_TAGS: Record<ThemeFamily, readonly string[]> = {
  floral:   ['🌸 Join', '💮 Bloom', '🌷 Vibe', '✿ Connect', '❀ Enter', '🍓 Tap In', '🩷 Grow', '🌺 Link Up'],
  lunar:    ['🌙 Enter', '☾ Midnight', '✦ Dark', '† Descend', '🦇 Rise', '🥀 Haunt', '⋆ Drift', '🌑 Join'],
  ethereal: ['✧ Ascend', '⟡ Dream', '✩ Float', '˚ Glow', '⊹ Shine', '✦ Drift', '⋆ Vibe', '𓂃 Enter'],
  tech:     ['⚡ Access', '◈ Hack', '⌘ Execute', '▣ Connect', '⌁ Breach', ':: Enter', '◆ Sync', '■ Join'],
  luxury:   ['♛ Elite', '✦ Premium', '◆ Select', '❖ Prestige', '✨ VIP', '⬡ Curated', '👑 Access', '💎 Join'],
  cute:     ['🎀 Join', '♡ Cute', '💗 Vibe', '✶ Enter', '💕 Play', '🧸 Cozy', '🌸 Tap', '🩷 Link Up'],
  cloud:    ['☁️ Float', '˚ Drift', '～ Chill', '° Vibe', '✧ Soft', '⟡ Dream', '☁ Enter', '𓂃 Join'],
  pixel:    ['■ Enter', '◆ Play', '★ Join', '▪ Access', '▰ Tap', '▱ Click', '▮ Go', '◆ Link'],
  stars:    ['✧ Shine', '✦ Star', '✩ Glow', '⭐ Enter', '☆ Join', '★ Rise', '⋆ Drift', '⟡ Link'],
  minimal:  ['· Join', '— Enter', '○ Access', '• Tap', '∙ Open', '◦ Connect', '— Go', '· Link'],
  japanese: ['「Join」', '〜Enter〜', '・Tap・', '「Access」', '〜Vibe〜', '・Open・', '「Go」', '〜Link〜'],
};

function pickTags(family: ThemeFamily, seed: string, count = 4): string {
  const pool = FAMILY_TAGS[family];
  const picked = pickMany(pool, seed, 60, count);
  return picked.join('  •  ');
}


function buildRecipe(family: ThemeFamily, seed: string): RemixRecipe {
  const pool = FAMILY_POOLS[family];
  const fonts: FontStyle[] = ['bold', 'serif', 'double', 'gothic', 'plain'];
  return {
    layout: 'header-title-divider-link-footer',
    header: choose(pool.headers, seed, 10),
    divider: choose(pool.dividers, seed, 14),
    footer: choose(pool.footers, seed, 13),
    titleLeft: choose(pool.titleFrames, seed, 11)[0],
    titleRight: choose(pool.titleFrames, seed, 11)[1],
    titleStyle: choose(fonts, seed, 15),
    accentCount: 4,
  };
}

function compose(
  recipe: RemixRecipe,
  title: string,
  url: string,
  seed: string,
  family: ThemeFamily,
): string {
  const fancyTitle = applyFont(clampTitle(title), recipe.titleStyle);
  const titleLine = `${recipe.titleLeft} ${fancyTitle} ${recipe.titleRight}`;
  const subtitle = choose(FAMILY_SUBTITLES[family], seed, 20);
  const tags = pickTags(family, seed, 4);
  // Strict 6-line compact layout: border / title / subtitle / link / tags / border
  return [recipe.header, titleLine, subtitle, url, tags, recipe.footer].join('\n');
}

export class StatusDesignEngine {
  public readonly themes = [...STATUS_THEMES];

  normalizeTheme(theme?: string): StatusTheme {
    const normalized = theme?.trim().toLowerCase() as StatusTheme | undefined;
    return normalized && STATUS_THEMES.includes(normalized) ? normalized : 'clean';
  }

  render(input: StatusDesignInput): StatusDesignResult {
    try {
      const url = input.url.trim();
      this.assertSafeUrl(url);

      const theme = this.normalizeTheme(input.theme);
      const family = THEME_TO_FAMILY[theme] ?? 'minimal';

      const rawTitle = compactSpaces((input.title ?? '').replaceAll(url, ''));
      // If URL is a WhatsApp group link and no title provided, use a clean default
      // instead of letting the URL bleed into the title
      const isWaLink = /chat\.whatsapp\.com\/|wa\.me\/join\//u.test(url);
      const title = rawTitle.length > 1
        ? rawTitle
        : isWaLink
          ? this.defaultTitle(theme, family, input.message)
          : this.defaultTitle(theme, family, input.message);

      const seed =
        input.seed?.trim() ||
        `${theme}:${url}:${title}:${Date.now()}:${crypto.randomUUID()}`;

      const recipe = buildRecipe(family, seed);
      const text = compose(recipe, title, url, seed, family);

      this.assertPreviewIntegrity(text, url);

      return {
        theme,
        text,
        url,
        recipe: `${family}:6line:${recipe.titleStyle}`,
        remixKey: seed.slice(0, 16),
      };
    } catch (error) {
      logger.error('[StatusDesignEngine] Render failed', {
        error: String(error),
        theme: input.theme,
      });
      throw error;
    }
  }

  private defaultTitle(theme: StatusTheme, family: ThemeFamily, message?: string): string {
    const hint = compactSpaces(message ?? '');
    if (hint) {
      return clampTitle(hint, 28);
    }

    const labels: Partial<Record<StatusTheme, string>> = {
      kawaii: 'Cute Corner',
      sakura: 'Sakura Space',
      flower: 'Bloom Room',
      japanese: 'Japanese Hub',
      cyber: 'Cyber Lane',
      minimal: 'Community',
      luxury: 'Premium Access',
      dreamcore: 'Dream Space',
      angelcore: 'Angel Zone',
      gothic: 'Night Gate',
      soft: 'Soft Space',
      cloud: 'Cloud Nine',
      moon: 'Moonlit Hub',
      ribbon: 'Cute Circle',
      pixel: 'Pixel Zone',
      stars: 'Star Lounge',
      hearts: 'Heart Space',
      girly: 'Girls Chat',
      guys: 'Guys Hub',
      yami: 'Dark Side',
      vampire: 'Night Clan',
      angel: 'Angel Zone',
      webcore: 'Web Portal',
      dark: 'Dark Mode',
      prestige: 'Exclusive Access',
      y2k: 'Y2K Portal',
      brat: 'Brat Zone',
      clean: 'Community',
    };

    return labels[theme] ?? ({
      floral: 'Flower Room',
      lunar: 'Moon Gate',
      ethereal: 'Dream Channel',
      tech: 'System Access',
      luxury: 'Private Access',
      cute: 'Cute Corner',
      cloud: 'Cloud Space',
      pixel: 'Pixel Zone',
      stars: 'Star Lounge',
      minimal: 'Community',
      japanese: 'Japanese Hub',
    } as Record<ThemeFamily, string>)[family];
  }

  assertSafeUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('A valid absolute URL is required');
    }

    if (!['http:', 'https:'].includes(parsed.protocol) || /[\r\n\s]/u.test(url)) {
      throw new Error('Only unmodified HTTP(S) URLs are supported');
    }
  }

  assertPreviewIntegrity(text: string, url: string): void {
    const matches = text.split(url).length - 1;
    if (matches !== 1) {
      throw new Error('Generated design must contain the URL exactly once');
    }
  }
}

export const statusDesignEngine = new StatusDesignEngine();

// ============================================================
// WA-Bridge — Omega Status Card Generator
// Procedural, compact, WhatsApp-native aesthetic
// Format: decoration → URL → title → decoration (no boxes)
// ============================================================

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

export const STATUS_THEMES = [
  // New theme families
  'kawaii', 'sakura', 'japanese', 'cyber', 'minimal', 'luxury',
  'dreamcore', 'angelcore', 'gothic', 'soft', 'cloud', 'moon',
  'ribbon', 'pixel', 'flower', 'stars', 'hearts',
  // Legacy aliases (kept for backward compat — mapped to families below)
  'girly', 'guys', 'yami', 'vampire', 'angel', 'webcore',
  'dark', 'prestige', 'y2k', 'brat', 'clean',
] as const;

export type StatusTheme = (typeof STATUS_THEMES)[number];

export interface StatusDesignInput {
  theme?: string;
  url: string;
  title?: string;
  message?: string;
}

export interface StatusDesignResult {
  theme: StatusTheme;
  text: string;
  url: string;
}

// ── Theme Family Mapping ──────────────────────────────────

type ThemeFamily =
  | 'floral' | 'lunar' | 'ethereal' | 'tech' | 'luxury'
  | 'cute' | 'cloud' | 'pixel' | 'stars' | 'minimal' | 'japanese';

const THEME_TO_FAMILY: Record<StatusTheme, ThemeFamily> = {
  // New
  kawaii: 'floral', sakura: 'floral', flower: 'floral',
  moon: 'lunar', gothic: 'lunar', vampire: 'lunar',
  dreamcore: 'ethereal', angelcore: 'ethereal', soft: 'ethereal',
  cyber: 'tech', webcore: 'tech', dark: 'tech',
  luxury: 'luxury', prestige: 'luxury',
  ribbon: 'cute', hearts: 'cute', y2k: 'cute', brat: 'cute',
  cloud: 'cloud', pixel: 'pixel', stars: 'stars',
  minimal: 'minimal', clean: 'minimal',
  japanese: 'japanese',
  // Legacy
  girly: 'floral', guys: 'cute', yami: 'lunar',
  angel: 'ethereal',
};

// ── Component Pools ───────────────────────────────────────
//
// True procedural generation: headers, title frames, and footers are
// independently selected. The Cartesian product of these pools creates
// thousands of unique combinations without any fixed templates.

interface FamilyPools {
  headers: readonly string[];
  titleFrames: ReadonlyArray<readonly [string, string]>; // [left, right]
  footers: readonly string[];
}

const FAMILY_POOLS: Record<ThemeFamily, FamilyPools> = {
  floral: {
    headers: [
      '✿・°。・✿', '❀════❀', '✿°｡・°✿', '꒰🌸꒱', '🌸⸝⸝🌸',
      '✿ · ✿ · ✿', '❀・✿・❀', '🌸・°。🌸', '✿｡✿', '꒷꒦꒷꒦꒷',
      '·˚ ༘ ✿', '˚₊‧꒰🌸꒱‧₊˚', '✾ · ✾', '🌺・🌸・🌺',
      '⸝⸝ ✿ ⸝⸝', '✿ ゜ ✿', '꒰ ✿ ꒱',
    ],
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
    ],
  },

  lunar: {
    headers: [
      '☾⋆｡', '☾ · ☽', '⋆｡☽', '☾━━━☽', '† ☾ †',
      '♱ · ♱', '☾⋆·˚', '⋆ ☾ ⋆', '☽｡⋆', '☾ ⸻ ☽',
      '·͜· ☾ ·͜·', '🌙 · 🌙', '☾ · · · ☽',
    ],
    titleFrames: [
      ['☾', '☽'], ['†', '†'], ['♱', '♱'], ['⋆', '⋆'], ['「', '」'],
      ['◆', '◆'], ['『', '』'], ['⌞', '⌝'], ['·', '·'], ['‹', '›'],
    ],
    footers: [
      '☾ Welcome ☽', '† Enter ✦', '⋆｡ Step Inside ｡⋆',
      '☾ After Dark ☽', '✦ Midnight ✦', '† Join the Night †',
      '☽ Enter the Gate ☾', '⋆ Come In ⋆', '☾ Open ☽',
    ],
  },

  ethereal: {
    headers: [
      '✧･ﾟ: *✧･ﾟ:*', '⊹₊ ⋆', '✧ ゜ ✧', '⟡ · ⟡', '˚ · ˚',
      '⋆｡°✩', '✦ ✧ ✦', '· ⋆ ·', '˚₊‧⁺', '⁺˚⋆',
      '✧ · ✧ · ✧', '゜゚・。⊹', '⟡ ゜ ⟡', '✩ · ✩',
      '˚₊· ͟͟͞͞꒷', '⊹ · ⊹', '✦ ⋆ ✦',
    ],
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
    ],
  },

  tech: {
    headers: [
      '⌁ ⚡ ⌁', '◈ :: ◈', '⌘ ⌁ ⌘', '⌁━━⌁', '⚡ ◈ ⚡',
      ':: ⌘ ::', '▣ · ▣', '⌘━━⌘', '◈ ⌁ ◈',
      '⚡⌁⚡', '::▣::', '⌘ · ⌘',
    ],
    titleFrames: [
      ['⌞', '⌝'], ['◈', '◈'], ['⌘', '⌘'], ['⟦', '⟧'], ['[', ']'],
      ['::', '::'], ['◆', '◆'], ['▣', '▣'], ['⌁', '⌁'], ['‹', '›'],
    ],
    footers: [
      '◈ Access Granted ◈', '⌘ Execute ⌘', '⚡ Connect ⚡',
      ':: Open Link ::', '▣ Enter System ▣', '⌁ Join Now ⌁',
      '◈ Tap In ◈', '⌘ Login ⌘',
    ],
  },

  luxury: {
    headers: [
      '♛ ✦ ♛', '◆ ✨ ◆', '✦ ♛ ✦', '❖ · ❖', '♛━━♛',
      '◆ · ◆', '✦ ◆ ✦', '❖ ✦ ❖', '♛ · ✦ · ♛',
      '◆━━━◆', '✦✦✦',
    ],
    titleFrames: [
      ['♛', '♛'], ['✦', '✦'], ['◆', '◆'], ['❖', '❖'], ['✨', '✨'],
      ['‹', '›'], ['「', '」'], ['⌞', '⌝'], ['·', '·'],
    ],
    footers: [
      '♛ Verified Access ♛', '✦ Private Link ✦', '◆ Select Members ◆',
      '❖ Enter ❖', '✨ Premium ✨', '♛ Join Now ♛',
      '◆ Exclusive ◆', '✦ Welcome ✦',
    ],
  },

  cute: {
    headers: [
      '╭─ 🎀 ─╮', '♡━━━♡', '🎀 · 🎀', '⌈✦⌋', '✶ · ✶',
      '💗 · 💗', '╭──♡──╮', '🎀・🎀', '♡ · ♡ · ♡',
      '✶✶✶', '💕 · 💕', '🎀 ─ 🎀',
    ],
    titleFrames: [
      ['🎀', '🎀'], ['♡', '♡'], ['💗', '💗'], ['✶', '✶'], ['·', '·'],
      ['꒰', '꒱'], ['「', '」'], ['⌈', '⌉'], ['✦', '✦'], ['💕', '💕'],
    ],
    footers: [
      '♡ See You Inside ♡', '🎀 Join Us 🎀', '💗 Welcome 💗',
      '✶ Tap to Enter ✶', '꒰ Open Link ꒱', '♡ Meet New Friends ♡',
      '🎀 Say Less 🎀', '💕 Come In 💕', '✶ Join Now ✶',
    ],
  },

  cloud: {
    headers: [
      '☁️ ～ ☁️', '～ ° ～', '☁ · ☁ · ☁', '～～～', '° ☁️ °',
      '˚ ～ ˚', '☁️ · · · ☁️', '～ ˚ ～',
    ],
    titleFrames: [
      ['☁️', '☁️'], ['～', '～'], ['°', '°'], ['˚', '˚'], ['·', '·'],
      ['〜', '〜'], ['❀', '❀'],
    ],
    footers: [
      '☁️ Float In ☁️', '～ Welcome ～', '° Drift Inside °',
      '˚ Open Link ˚', '☁ Join Now ☁', '～ Enter ～',
    ],
  },

  pixel: {
    headers: [
      '■ ◆ ■', '★ ◆ ★', '▪ ■ ▪', '◆◆◆', '■━■━■',
      '★ · ★', '▪ ◆ ▪', '■ · ■ · ■',
    ],
    titleFrames: [
      ['■', '■'], ['◆', '◆'], ['★', '★'], ['▪', '▪'], ['▰', '▰'],
      ['[', ']'], ['‹', '›'], ['·', '·'],
    ],
    footers: [
      '■ Enter ■', '◆ Click ◆', '★ Join ★', '▪ Open ▪',
      '■ Access ■', '◆ Tap In ◆',
    ],
  },

  stars: {
    headers: [
      '✧ ✦ ✧', '✩ ✦ ✩', '⭐ · ⭐', '✦━━✦', '✧ · ✧ · ✧',
      '✩ · ✩', '✦ ✧ ✦ ✧ ✦', '⭐ ✦ ⭐', '✧✧✧',
      '✦ · ✦', '✩━━✩', '☆ ✦ ☆',
    ],
    titleFrames: [
      ['✧', '✧'], ['✦', '✦'], ['✩', '✩'], ['⭐', '⭐'], ['☆', '☆'],
      ['★', '★'], ['·', '·'], ['⋆', '⋆'],
    ],
    footers: [
      '✦ Join Now ✦', '✧ Shine Inside ✧', '✩ Welcome ✩',
      '⭐ Open Link ⭐', '✦ Enter ✦', '☆ Tap In ☆',
      '✧ Enjoy ✧', '✩ Access ✩',
    ],
  },

  minimal: {
    headers: [
      '· · ·', '— ○ —', '∙ ∙ ∙', '─────', '· — ·',
      '○ · ○', '─ · ─', '···', '— · —',
      '∙∙∙', '○ ─ ○',
    ],
    titleFrames: [
      ['·', '·'], ['—', '—'], ['○', '○'], ['‹', '›'], ['[', ']'],
      ['(', ')'], ['|', '|'], ['-', '-'],
    ],
    footers: [
      '· Open Link ·', '— Join ——', '○ Enter ○',
      '· Tap In ·', '— Welcome —', '∙ Access ∙',
    ],
  },

  japanese: {
    headers: [
      '「◆」', '〜★〜', '・ω・', '「✦」', '〜 ♡ 〜',
      '「 ✿ 」', '・☆・', '〜✧〜', '「◈」', '。♡。',
      '・｡・', '〜 ⟡ 〜',
    ],
    titleFrames: [
      ['「', '」'], ['〔', '〕'], ['【', '】'], ['『', '』'], ['〖', '〗'],
      ['·', '·'], ['・', '・'], ['♡', '♡'], ['✦', '✦'],
    ],
    footers: [
      '「 ようこそ 」', '〜 Join Us 〜', '・参加する・',
      '「 Open Link 」', '〜 Welcome 〜', '・Enter・',
      '「 Tap In 」', '〜 どうぞ 〜',
    ],
  },
};

// ── Utilities ─────────────────────────────────────────────

function hashNumber(seed: string): number {
  return Number.parseInt(
    crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12),
    16
  );
}

function choose<T>(items: readonly T[], seed: string, offset: number): T {
  return items[hashNumber(`${seed}:${offset}`) % items.length]!;
}

function clampTitle(title: string, maxChars = 28): string {
  const cleaned = title.replace(/\s+/gu, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

function compose(
  pool: FamilyPools,
  title: string,
  url: string,
  seed: string
): string {
  const header = choose(pool.headers, seed, 1);
  const [frameL, frameR] = choose(pool.titleFrames, seed, 2);
  const footer = choose(pool.footers, seed, 3);
  const titleLine = `${frameL} ${clampTitle(title)} ${frameR}`;
  return [header, url, titleLine, footer].join('\n');
}

// ── Engine ────────────────────────────────────────────────

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
      const family = THEME_TO_FAMILY[theme] ?? 'floral';
      const pool = FAMILY_POOLS[family];

      // Derive a short display title: prefer fetched metadata, then the theme family label.
      const rawTitle = input.title?.replaceAll(url, '').trim();
      const title = rawTitle && rawTitle.length > 1 ? rawTitle : this.defaultTitle(theme);

      // Seed combines theme + url + time + randomness for true per-render uniqueness.
      const seed = `${theme}:${url}:${Date.now()}:${crypto.randomUUID()}`;
      const text = compose(pool, title, url, seed);
      this.assertPreviewIntegrity(text, url);
      return { theme, text, url };
    } catch (error) {
      logger.error('[StatusDesignEngine] Render failed', {
        error: String(error),
        theme: input.theme,
      });
      throw error;
    }
  }

  private defaultTitle(theme: StatusTheme): string {
    const labels: Partial<Record<StatusTheme, string>> = {
      kawaii: 'Kawaii Group', sakura: 'Sakura Chat', flower: 'Garden Chat',
      japanese: 'Japanese Hub', cyber: 'Cyber Network', minimal: 'Community',
      luxury: 'Private Access', dreamcore: 'Dream Space', angelcore: 'Angel Hub',
      gothic: 'Night Gate', soft: 'Soft Space', cloud: 'Cloud Chat',
      moon: 'Moonlit Hub', ribbon: 'Cute Group', pixel: 'Pixel Zone',
      stars: 'Star Lounge', hearts: 'Heart Space',
      girly: 'Girls Chat', guys: 'Guys Hub', yami: 'Dark Side',
      vampire: 'Night Clan', angel: 'Angel Zone', webcore: 'Web Portal',
      dark: 'Dark Mode', prestige: 'Premium Access', y2k: 'Y2K Portal',
      brat: 'Brat Zone', clean: 'Community',
    };
    return labels[theme] ?? 'Community';
  }

  assertSafeUrl(url: string): void {
    let parsed: URL;
    try { parsed = new URL(url); } catch {
      throw new Error('A valid absolute URL is required');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || /[\r\n\s]/u.test(url)) {
      throw new Error('Only unmodified HTTP(S) URLs are supported');
    }
  }

  assertPreviewIntegrity(text: string, url: string): void {
    const matches = text.split(url).length - 1;
    if (matches !== 1) throw new Error('Generated design must contain the URL exactly once');
  }
}

export const statusDesignEngine = new StatusDesignEngine();

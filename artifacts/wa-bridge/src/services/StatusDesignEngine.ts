import crypto from 'crypto';
import { logger } from '../utils/logger.js';

export const STATUS_THEMES = [
  'cyber', 'girly', 'guys', 'gothic', 'kawaii', 'yami', 'vampire', 'angel',
  'webcore', 'dark', 'prestige', 'y2k', 'brat', 'clean',
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

type ThemeSpec = {
  label: string;
  accents: readonly string[];
  titleWords: readonly string[];
};

const THEMES: Record<StatusTheme, ThemeSpec> = {
  cyber: { label: 'CYBER DROP', accents: ['⌁', '⚡', '⌘', '▣'], titleWords: ['neon', 'access', 'signal', 'online'] },
  girly: { label: 'GIRLY EDIT', accents: ['♡', '💗', '୨୧', '✿'], titleWords: ['pretty', 'sweet', 'lovely', 'link'] },
  guys: { label: 'GUYS ONLY', accents: ['◆', '🔥', '◈', '✦'], titleWords: ['tap', 'in', 'open', 'now'] },
  gothic: { label: 'GOTHIC', accents: ['†', '🕯', '☾', '♱'], titleWords: ['midnight', 'gate', 'shadow', 'entry'] },
  kawaii: { label: 'KAWAII', accents: ['୨୧', '🌸', '♡', '꒰'], titleWords: ['soft', 'cute', 'open', 'link'] },
  yami: { label: 'YAMI', accents: ['「', '闇', '🖤', '┆'], titleWords: ['shadow', 'path', 'dark', 'signal'] },
  vampire: { label: 'VAMPIRE', accents: ['☾', '🩸', '†', '♛'], titleWords: ['bloodline', 'after', 'dark', 'hours'] },
  angel: { label: 'ANGEL', accents: ['✦', '🪽', '♡', '⋆'], titleWords: ['soft', 'access', 'heaven', 'sent'] },
  webcore: { label: 'WEBCORE', accents: ['⌘', '💿', '⌁', '::'], titleWords: ['link.exe', 'web', 'portal', 'live'] },
  dark: { label: 'DARK', accents: ['▓', '◼', '▰', '■'], titleWords: ['clean', 'access', 'dark', 'mode'] },
  prestige: { label: 'PRESTIGE', accents: ['♛', '✨', '◆', '✦'], titleWords: ['verified', 'private', 'select', 'access'] },
  y2k: { label: 'Y2K', accents: ['☆', '🛸', '✧', '💿'], titleWords: ['click', '2', 'enter', 'portal'] },
  brat: { label: 'BRAT', accents: ['💚', '★', '!', '✶'], titleWords: ['say', 'less', 'status', 'update'] },
  clean: { label: 'UPDATE', accents: ['•', '—', '·', '°'], titleWords: ['open', 'link', 'update', 'shared'] },
};

type BorderStyle = {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
};

type DesignLayout = {
  border: BorderStyle;
  decoration: string;
  title: (title: string, accent: string) => string;
  footer: (accent: string, words: readonly string[]) => string;
  spacing: number;
  alignment: 'center' | 'left' | 'right';
};

const BORDER_FAMILIES: readonly [string, string, string, string, string, string][] = [
  ['╭', '╮', '╰', '╯', '─', '│'],
  ['┌', '┐', '└', '┘', '─', '│'],
  ['╔', '╗', '╚', '╝', '═', '║'],
  ['┏', '┓', '┗', '┛', '━', '┃'],
  ['◤', '◥', '◣', '◢', '━', '┃'],
  ['┍', '┑', '┕', '┙', '━', '│'],
  ['┎', '┒', '┖', '┚', '═', '║'],
  ['╓', '╖', '╙', '╜', '─', '║'],
  ['╒', '╕', '╘', '╛', '═', '│'],
  ['╭', '╮', '╰', '╯', '·', '│'],
  ['⟅', '⟆', '⟅', '⟆', '═', '│'],
  ['《', '》', '《', '》', '━', '│'],
  ['〔', '〕', '〖', '〗', '─', '│'],
  ['⟦', '⟧', '⟦', '⟧', '━', '│'],
  ['❲', '❳', '❲', '❳', '─', '│'],
  ['⸢', '⸣', '⸤', '⸥', '─', '│'],
];

const HORIZONTAL_VARIANTS = ['─', '━', '═', '—', '·', '⋅', '╌', '╍', '┄', '┅', '⎯', '﹏'];
const DECORATION_PAIRS = [
  ['✿', '✿'], ['♡', '♡'], ['☆', '☆'], ['✦', '✦'], ['⋆', '⋆'], ['☾', '☽'],
  ['⌁', '⌁'], ['⌘', '⌘'], ['୨୧', '୨୧'], ['「', '」'], ['《', '》'], ['◈', '◈'],
  ['†', '†'], ['꒰', '꒱'], ['◤', '◥'], ['⟦', '⟧'], ['❀', '❀'], ['⚡', '⚡'],
];
const DECORATION_MIDDLES = ['·°。·', '・。°・', '⋆｡', '｡⋆', '✧･ﾟ', 'ﾟ･✧', '┈┈', '⸻', '···', '°˖✧', '✧˖°'];

// These pools are intentionally compositional. Their Cartesian products create
// hundreds of possible components without turning the engine into a template
// library: every render chooses border, decoration, title, footer, spacing, and
// alignment independently.
const BORDER_STYLES: BorderStyle[] = BORDER_FAMILIES.flatMap((family, familyIndex) =>
  HORIZONTAL_VARIANTS.slice(0, familyIndex % 5 === 0 ? HORIZONTAL_VARIANTS.length : 7).map((horizontal) => ({
    topLeft: family[0],
    topRight: family[1],
    bottomLeft: family[2],
    bottomRight: family[3],
    horizontal,
    vertical: family[5],
  })),
);

const DECORATIONS = DECORATION_PAIRS.flatMap(([left, right], pairIndex) =>
  DECORATION_MIDDLES.map((middle, middleIndex) =>
    pairIndex % 2 === 0 || middleIndex % 2 === 0 ? `${left}${middle}${right}` : `${left} ${middle} ${right}`,
  ),
);

type TitleLayout = (title: string, accent: string) => string;
type FooterLayout = (accent: string, words: readonly string[]) => string;

const TITLE_FRAMES = [
  ['「', '」'], ['⌞', '⌝'], ['⟦', '⟧'], ['╰─', '─╯'], ['《', '》'], ['〔', '〕'],
  ['❲', '❳'], ['⸢', '⸥'], ['꒰', '꒱'], ['◤', '◥'], ['‹', '›'], ['⟅', '⟆'],
] as const;
const TITLE_SEPARATORS = [' ', '  ', ' · ', '・', ' ⋆ ', ' — ', ' ⟡ ', ' ° ', ' :: ', ' / '] as const;
const TITLE_LAYOUTS: TitleLayout[] = TITLE_FRAMES.flatMap(([left, right]) =>
  TITLE_SEPARATORS.map((separator) => (title, accent) =>
    `${left}${separator === ' ' ? ` ${accent} ${separator}` : `${separator}${accent}${separator}`}${title}${separator}${accent} ${right}`,
  ),
);

const FOOTER_FRAMES = [
  ['╰', '╯'], ['⌁', '⌁'], ['「', '」'], ['⟡', '⟡'], ['┈', '┈'], ['⋆', '⋆'],
  ['·', '·'], ['✦', '✦'], ['☾', '☽'], ['◈', '◈'], ['—', '—'], ['⌞', '⌝'],
] as const;
const FOOTER_SEPARATORS = [' ', ' · ', ' / ', ' — ', ' ⋆ ', ' ⟡ ', '・', ' :: ', ' + ', ' … '] as const;
const FOOTER_LAYOUTS: FooterLayout[] = FOOTER_FRAMES.flatMap(([left, right]) =>
  FOOTER_SEPARATORS.map((separator) => (accent, words) =>
    `${left} ${words[0]}${separator}${words[1]} ${accent} ${right}`,
  ),
);

const SPACING_PATTERNS = [0, 0, 1, 1, 1, 2, 2, 3];
const ALIGNMENTS: DesignLayout['alignment'][] = ['center', 'center', 'center', 'left', 'right'];

function visibleWidth(value: string): number {
  return [...value].reduce((width, char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(char) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return width;
    return width + (codePoint >= 0x1100 ? 2 : 1);
  }, 0);
}

function repeatToWidth(character: string, width: number): string {
  if (width <= 0) return '';
  return Array.from({ length: width }, () => character).join('');
}

function centerLine(value: string, width: number, alignment: DesignLayout['alignment'] = 'center'): string {
  const remaining = Math.max(0, width - visibleWidth(value));
  const left = alignment === 'left' ? 0 : alignment === 'right' ? remaining : Math.floor(remaining / 2);
  return `${' '.repeat(left)}${value}${' '.repeat(remaining - left)}`;
}

function hashNumber(seed: string): number {
  return Number.parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12), 16);
}

function choose<T>(items: readonly T[], seed: string, offset: number): T {
  return items[hashNumber(`${seed}:${offset}`) % items.length]!;
}

function clampTitle(title: string, width: number): string {
  const cleaned = title.replace(/\s+/gu, ' ').trim();
  const maxWidth = Math.max(12, width - 8);
  if (visibleWidth(cleaned) <= maxWidth) return cleaned;
  const chars = [...cleaned];
  let result = '';
  for (const char of chars) {
    if (visibleWidth(`${result}${char}…`) > maxWidth) break;
    result += char;
  }
  return `${result}…`;
}

function makeLayout(seed: string): DesignLayout {
  const border = choose(BORDER_STYLES, seed, 1);
  return {
    border,
    decoration: choose(DECORATIONS, seed, 2),
    title: choose(TITLE_LAYOUTS, seed, 3),
    footer: choose(FOOTER_LAYOUTS, seed, 4),
    spacing: choose(SPACING_PATTERNS, seed, 5),
    alignment: choose(ALIGNMENTS, seed, 6),
  };
}

function compose(spec: ThemeSpec, title: string, url: string, seed: string): string {
  const layout = makeLayout(seed);
  const urlWidth = visibleWidth(url);
  // The frame grows with the URL. This keeps short links airy while preventing
  // long WhatsApp links from being squeezed against decorative characters.
  const frameWidth = Math.max(28, urlWidth + 8, visibleWidth(title) + 10, visibleWidth(layout.decoration) + 10);
  const innerWidth = frameWidth - 2;
  const accent = choose(spec.accents, seed, 7);
  const words = [choose(spec.titleWords, seed, 8), choose(spec.titleWords, seed, 9)];
  const titleLine = layout.title(clampTitle(title, innerWidth), accent);
  const footerLine = layout.footer(accent, words);
  const horizontal = repeatToWidth(layout.border.horizontal, frameWidth - 2);
  const top = `${layout.border.topLeft}${horizontal}${layout.border.topRight}`;
  const bottom = `${layout.border.bottomLeft}${horizontal}${layout.border.bottomRight}`;
  const frame = (line: string, alignment = layout.alignment) =>
    `${layout.border.vertical}${centerLine(line, innerWidth, alignment)}${layout.border.vertical}`;
  const urlLine = frame(url, 'center');
  const lines = [
    top,
    ...Array.from({ length: layout.spacing }, () => frame('')),
    frame(layout.decoration, 'center'),
    urlLine,
    frame(titleLine, layout.alignment),
    frame(footerLine, 'center'),
    bottom,
  ];
  return lines.join('\n');
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
      const title = (input.title?.replaceAll(url, '').trim() || THEMES[theme].label).slice(0, 64);
      // Keep generated status cards compact. The optional message remains in
      // the input contract for callers, but descriptions are intentionally
      // omitted so long web metadata cannot overwhelm the status.
      const seed = `${theme}:${url}:${title}:${Date.now()}:${crypto.randomUUID()}`;
      const text = compose(THEMES[theme], title, url, seed);
      this.assertPreviewIntegrity(text, url);
      return { theme, text, url };
    } catch (error) {
      logger.error('[StatusDesignEngine] Render failed', { error: String(error), theme: input.theme });
      throw error;
    }
  }

  assertSafeUrl(url: string): void {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('A valid absolute URL is required'); }
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

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
  top: string;
  divider: string;
  accent?: string;
};

const THEMES: Record<StatusTheme, ThemeSpec> = {
  cyber: { label: 'CYBER DROP', top: '⌁  CYBER DROP  ⌁', divider: '━━━ neon access ━━━', accent: '⚡' },
  girly: { label: 'GIRLY EDIT', top: '♡  GIRLY EDIT  ♡', divider: '──── pretty link ────', accent: '💗' },
  guys: { label: 'GUYS ONLY', top: '◆  GUYS ONLY  ◆', divider: '──── tap in ────', accent: '🔥' },
  gothic: { label: 'GOTHIC', top: '†  GOTHIC NOTICE  †', divider: '━━━━ midnight gate ━━━━', accent: '🕯' },
  kawaii: { label: 'KAWAII', top: '୨୧  KAWAII DROP  ୨୧', divider: '﹏﹏ open link ﹏﹏', accent: '🌸' },
  yami: { label: 'YAMI', top: '「 闇 」 YAMI SIGNAL', divider: '━━━━ shadow path ━━━━', accent: '🖤' },
  vampire: { label: 'VAMPIRE', top: '☾  VAMPIRE ACCESS  ☽', divider: '──── bloodline ────', accent: '🩸' },
  angel: { label: 'ANGEL', top: '✦  ANGEL NOTICE  ✦', divider: '──── soft access ────', accent: '🪽' },
  webcore: { label: 'WEBCORE', top: '⌘  webcore://live', divider: '──── link.exe ────', accent: '💿' },
  dark: { label: 'DARK', top: '▓  DARK MODE  ▓', divider: '━━━━ clean access ━━━━', accent: '◼' },
  prestige: { label: 'PRESTIGE', top: '♛  PRESTIGE ACCESS  ♛', divider: '──── verified link ────', accent: '✨' },
  y2k: { label: 'Y2K', top: '☆  Y2K PORTAL  ☆', divider: '──── click 2 enter ────', accent: '🛸' },
  brat: { label: 'BRAT', top: 'brat status update', divider: '──── say less ────', accent: '💚' },
  clean: { label: 'UPDATE', top: 'Update', divider: '────────────', accent: '•' },
};

function compact(spec: ThemeSpec, title: string, url: string, message: string): string {
  return [
    spec.top,
    `${spec.accent ?? '•'} ${title}`,
    spec.divider,
    url,
    message,
  ].join('\n');
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
      const title = (input.title?.trim() || THEMES[theme].label).slice(0, 64);
      const message = (input.message?.trim() || 'Tap the link to continue.').slice(0, 320);
      const text = compact(THEMES[theme], title, url, message);
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

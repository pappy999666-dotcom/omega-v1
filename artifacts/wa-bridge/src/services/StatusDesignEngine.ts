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

type ThemeSpec = { mark: string; title: string; divider: string; accent: string };

const THEMES: Record<StatusTheme, ThemeSpec> = {
  cyber: { mark: '✦', title: 'CYBER DROP', divider: '━━━ CYAN SIGNAL ━━━', accent: 'online now' },
  girly: { mark: '♡', title: 'GIRLY EDIT', divider: '──── sweet line ────', accent: 'soft launch' },
  guys: { mark: '◆', title: 'GUYS CLUB', divider: '━━━━ bold access ━━━━', accent: 'tap in' },
  gothic: { mark: '†', title: 'GOTHIC NOTE', divider: '━━━━ dark lace ━━━━', accent: 'enter quietly' },
  kawaii: { mark: '୨୧', title: 'KAWAII UPDATE', divider: '⌒⌒ sparkle link ⌒⌒', accent: 'open me' },
  yami: { mark: '影', title: 'YAMI SIGNAL', divider: '━━━━ moon path ━━━━', accent: 'beyond the shade' },
  vampire: { mark: '☽', title: 'VAMPIRE PASS', divider: '━━━━ crimson line ━━━━', accent: 'after dark' },
  angel: { mark: '✧', title: 'ANGEL NOTICE', divider: '──── halo link ────', accent: 'light ahead' },
  webcore: { mark: '⌘', title: 'WEBCORE PAGE', divider: '──── hyperline ────', accent: 'click to browse' },
  dark: { mark: '●', title: 'DARK MODE', divider: '━━━━ night link ━━━━', accent: 'low glow' },
  prestige: { mark: '♔', title: 'PRESTIGE', divider: '━━━━ premium access ━━━━', accent: 'by invitation' },
  y2k: { mark: '✩', title: 'Y2K PORTAL', divider: '════ chrome link ════', accent: 'future classic' },
  brat: { mark: '★', title: 'BRAT ENERGY', divider: '━━━━ lime line ━━━━', accent: 'loud & clear' },
  clean: { mark: '•', title: 'UPDATE', divider: '────────────', accent: 'open link' },
};

function compact(spec: ThemeSpec, url: string, title: string, message: string): string {
  return [
    `${spec.mark} ${title || spec.title}`,
    spec.divider,
    url,
    message || spec.accent,
  ].join('\n');
}

export class StatusDesignEngine {
  public readonly themes = [...STATUS_THEMES];

  normalizeTheme(theme?: string): StatusTheme {
    const normalized = theme?.trim().toLowerCase().replace('yamii', 'yami') as StatusTheme | undefined;
    return normalized && STATUS_THEMES.includes(normalized) ? normalized : 'clean';
  }

  render(input: StatusDesignInput): StatusDesignResult {
    try {
      const url = input.url.trim();
      this.assertSafeUrl(url);
      const theme = this.normalizeTheme(input.theme);
      const text = compact(
        THEMES[theme],
        url,
        (input.title?.trim() || THEMES[theme].title).slice(0, 42),
        (input.message?.trim() || THEMES[theme].accent).slice(0, 180),
      );
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
    if (!['http:', 'https:'].includes(parsed.protocol) || /[\r\n\s]/u.test(url)) throw new Error('Only unmodified HTTP(S) URLs are supported');
  }

  assertPreviewIntegrity(text: string, url: string): void {
    const lines = text.split('\n');
    if (text.split(url).length - 1 !== 1 || lines.length !== 4 || lines[2] !== url) {
      throw new Error('Generated design violates compact URL layout');
    }
  }
}

export const statusDesignEngine = new StatusDesignEngine();

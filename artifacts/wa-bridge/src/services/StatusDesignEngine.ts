import { logger } from '../utils/logger.js';

export const STATUS_THEMES = [
  'luxury', 'premium', 'vip', 'cyber', 'hacker', 'gothic', 'noir', 'glass',
  'modern', 'elegant', 'royal', 'clean', 'minimal', 'kawaii', 'yamii', 'sakura',
  'anime', 'neon', 'shadow', 'galaxy',
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

type ThemeRenderer = (input: Required<Pick<StatusDesignInput, 'url' | 'title' | 'message'>>) => string;

const separated = (top: string, url: string, bottom: string): string =>
  `${top}\n\n\n${url}\n\n\n${bottom}`;

const renderers: Record<StatusTheme, ThemeRenderer> = {
  luxury: ({ url, title, message }) => separated(`╔═══ ◆ ${title} ◆ ═══╗\n      ${message}`, url, '╚══════ ◇ ══════╝'),
  premium: ({ url, title, message }) => separated(`┏━━━━━━━━━━━━━━┓\n┃  ${title.toUpperCase()}\n┗━ ${message}`, url, '━━ VERIFIED ACCESS ━━'),
  vip: ({ url, title, message }) => separated(`╭─── VIP PASS ───╮\n│ ${title}\n│ ${message}`, url, '╰── ADMIT ONE ──╯'),
  cyber: ({ url, title, message }) => separated(`[SYS://ONLINE]\n> ${title.toUpperCase()}\n> ${message}`, url, '[END_TRANSMISSION]'),
  hacker: ({ url, title, message }) => separated(`root@status:~$ open\nACCESS: ${title}\n${message}`, url, 'root@status:~$ _'),
  gothic: ({ url, title, message }) => separated(`┏━━━━ † ━━━━┓\n   ${title}\n   ${message}`, url, '┗━━━━ † ━━━━┛'),
  noir: ({ url, title, message }) => separated(`BLACK EDITION\n────────────\n${title}\n${message}`, url, '────────────\nENTER THE STORY'),
  glass: ({ url, title, message }) => separated(`╭ · · · · · · ╮\n  ${title}\n  ${message}\n╰ · · · · · · ╯`, url, 'CLEAR ACCESS / OPEN NOW'),
  modern: ({ url, title, message }) => separated(`${title.toUpperCase()}  /  NOW\n${message}\n────────────`, url, 'EXPLORE →'),
  elegant: ({ url, title, message }) => separated(`— ${title} —\n\n${message}`, url, 'With distinction\n────────────'),
  royal: ({ url, title, message }) => separated(`♔  ROYAL NOTICE  ♔\n${title}\n╔ ${message} ╗`, url, '♜  BY INVITATION  ♜'),
  clean: ({ url, title, message }) => separated(`${title}\n${message}`, url, 'Open link to continue'),
  minimal: ({ url, title, message }) => separated(`${title.toLowerCase()}\n—\n${message}`, url, 'view more.'),
  kawaii: ({ url, title, message }) => separated(`୨୧  ${title}  ୨୧\n${message}\n⌒⌒⌒⌒⌒`, url, '୨୧ tap to discover ୨୧'),
  yamii: ({ url, title, message }) => separated(`「 闇 」 ${title}\n━━━━━━━━\n${message}`, url, '影の向こうへ  /  BEYOND'),
  sakura: ({ url, title, message }) => separated(`﹏﹏ SAKURA ﹏﹏\n${title}\n${message}`, url, '花 • OPEN • 花'),
  anime: ({ url, title, message }) => separated(`『 ${title.toUpperCase()} 』\nEPISODE: NOW\n${message}`, url, '次回へつづく — CONTINUE'),
  neon: ({ url, title, message }) => separated(`╔═ N E O N ═╗\n${title.toUpperCase()}\n>>> ${message}`, url, '╚═ LIVE SIGNAL ═╝'),
  shadow: ({ url, title, message }) => separated(`▓▒░ ${title} ░▒▓\n${message}\n░░░░░░░░░░`, url, 'STEP OUT OF THE SHADOW'),
  galaxy: ({ url, title, message }) => separated(`✦ .  GALAXY SIGNAL  . ✦\n${title}\n⋆ ${message} ⋆`, url, '✧ DESTINATION UNLOCKED ✧'),
};

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
      const text = renderers[theme]({
        url,
        title: input.title?.trim() || 'Exclusive Update',
        message: input.message?.trim() || 'A new experience is ready for you.',
      });
      this.assertPreviewIntegrity(text, url);
      return { theme, text, url };
    } catch (error) {
      logger.error('[StatusDesignEngine] Render failed', { error: String(error), theme: input.theme });
      throw error;
    }
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
    if (matches !== 1 || !text.includes(`\n\n${url}\n\n`)) {
      throw new Error('Generated design violates link-preview spacing or URL integrity');
    }
  }
}

export const statusDesignEngine = new StatusDesignEngine();

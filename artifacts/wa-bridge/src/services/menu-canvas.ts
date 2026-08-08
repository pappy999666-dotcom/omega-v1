// ============================================================
// OMEGA V1 — Dynamic Menu Canvas
//
// The canvas is a generated default dashboard image. It never changes the
// menu text or navigation logic. A user-configured menu image/video always
// wins over this fallback.
// ============================================================

import fs from 'node:fs';
import sharp from 'sharp';
import type { UserConfig, SessionMeta } from '../types/index.js';
import type { BridgeWASocket } from '../whatsapp/baileys-types.js';
import { ALL_COMMANDS } from '../whatsapp/command-parser.js';
import { navCommandLines, navFor } from '../whatsapp/menu-registry.js';
import { profilePicBuffer } from '../whatsapp/utils/identity.js';

export interface MenuCanvasMedia {
  buffer: Buffer;
  type: 'image' | 'video';
  mimetype: string;
  caption: string;
}

export interface MenuCanvasOptions {
  prefix: string;
  menuTarget: 'main' | 'group';
  status?: string;
  userName?: string;
  caption: string;
  config: UserConfig;
  meta: SessionMeta | null;
  socket?: BridgeWASocket;
}

interface CanvasNavItem {
  icon: string;
  title: string;
  subtitle: string;
  count?: number;
}

interface CanvasData {
  botName: string;
  userName: string;
  userId: string;
  status: string;
  prefix: string;
  mode: string;
  timezone: string;
  date: string;
  time: string;
  runtime: string;
  platform: string;
  session: string;
  premium: string;
  version: string;
  profilePicture?: string;
  navigation: CanvasNavItem[];
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatNow(timezone?: string): { date: string; time: string; timezone: string } {
  const tz = timezone?.trim() || undefined;
  try {
    const date = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    }).format(new Date());
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    return { date, time, timezone: tz ?? new Intl.DateTimeFormat().resolvedOptions().timeZone };
  } catch {
    return {
      date: new Date().toISOString().slice(0, 10),
      time: new Date().toISOString().slice(11, 16),
      timezone: 'UTC',
    };
  }
}

function runtimeString(): string {
  const seconds = Math.floor(process.uptime());
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function navigationFor(prefix: string, menuTarget: 'main' | 'group'): CanvasNavItem[] {
  return navFor(menuTarget)
    .filter((nav) => nav.id !== 'help')
    .map((nav) => ({
      icon: nav.emoji,
      title: nav.label,
      subtitle: nav.desc,
      count: nav.id === 'pair' ? undefined : navCommandLines(prefix, nav, menuTarget, ALL_COMMANDS).length,
    }));
}

async function profilePictureDataUri(options: MenuCanvasOptions): Promise<string | undefined> {
  const profilePictureUrl = (options.socket as unknown as {
    profilePictureUrl?: (jid: string, type: string) => Promise<string | null>;
  } | undefined)?.profilePictureUrl;
  const selfJid = profilePictureUrl && options.meta?.phone
    ? `${options.meta.phone}@s.whatsapp.net`
    : undefined;
  if (!selfJid || !profilePictureUrl) return undefined;
  try {
    // Reuse the shared helper so profile requests have the bridge's timeout
    // and failure handling instead of blocking a menu send indefinitely.
    const source = await profilePicBuffer(options.socket!, selfJid);
    if (!source) return undefined;
    const normalized = await sharp(source).resize(220, 220, { fit: 'cover' }).png().toBuffer();
    return `data:image/png;base64,${normalized.toString('base64')}`;
  } catch {
    return undefined;
  }
}

async function canvasData(options: MenuCanvasOptions): Promise<CanvasData> {
  const now = formatNow(options.config.timezone);
  return {
    botName: 'OMEGA • V1',
    userName: options.userName || 'Operator',
    userId: options.meta?.telegramId || '—',
    status: options.status || 'ONLINE',
    prefix: options.prefix || 'None',
    mode: options.config.responseMode || 'txt',
    timezone: now.timezone,
    date: now.date,
    time: now.time,
    runtime: runtimeString(),
    platform: process.platform,
    session: options.meta?.sessionName || options.meta?.sessionId || '—',
    premium: 'READY',
    version: 'OMEGA V1',
    profilePicture: await profilePictureDataUri(options),
    navigation: navigationFor(options.prefix, options.menuTarget),
  };
}

function text(x: number, y: number, value: unknown, size: number, color = '#c8f7ff', weight = 400, anchor = 'start'): string {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="${size}px" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, color = '#1ad9ff', opacity = 0.35, width = 2): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${width}"/>`;
}

function card(x: number, y: number, width: number, height: number, accent = '#14dfff'): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="20" fill="#071521" fill-opacity=".88" stroke="${accent}" stroke-opacity=".55" stroke-width="2"/>`;
}

function buildSvg(data: CanvasData): string {
  const navCards = data.navigation.slice(0, 6);
  const navMarkup = navCards.map((item, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 72 + column * 474;
    const y = 760 + row * 212;
    const count = item.count === undefined ? 'READY' : `[${item.count}]`;
    return [
      card(x, y, 438, 174, index % 2 === 0 ? '#14dfff' : '#4b7dff'),
      text(x + 28, y + 48, `${item.icon}  ${item.title}`, 27, '#f1fdff', 700),
      text(x + 28, y + 83, count, 20, '#62edff', 700),
      text(x + 28, y + 122, truncate(item.subtitle, 34), 17, '#91b9c5'),
      line(x + 28, y + 143, x + 410, y + 143, '#1ad9ff', 0.2, 1),
      text(x + 410, y + 164, 'LIVE', 13, '#5bffcf', 700, 'end'),
    ].join('');
  }).join('');

  const statusRows = [
    ['STATUS', data.status],
    ['PREFIX', data.prefix],
    ['MODE', data.mode.toUpperCase()],
    ['TIMEZONE', truncate(data.timezone, 22)],
    ['DATE', data.date],
    ['TIME', data.time],
    ['RUNTIME', data.runtime],
    ['PLATFORM', data.platform],
  ];
  const statusMarkup = statusRows.map(([label, value], index) => {
    const y = 248 + index * 48;
    return `${text(650, y, label, 15, '#5e9eaf', 700)}${text(860, y, value, 17, '#d9fbff', 500, 'end')}${line(650, y + 14, 1010, y + 14, '#1ad9ff', 0.12, 1)}`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#02070d"/><stop offset=".52" stop-color="#061522"/><stop offset="1" stop-color="#02050b"/>
    </linearGradient>
    <linearGradient id="cyan" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0bdcff"/><stop offset="1" stop-color="#4c6dff"/>
    </linearGradient>
    <pattern id="grid" width="54" height="54" patternUnits="userSpaceOnUse">
      <path d="M54 0H0V54" fill="none" stroke="#1bdcff" stroke-opacity=".055" stroke-width="1"/>
    </pattern>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="8" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="34"/></filter>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <rect width="1080" height="1920" fill="url(#grid)"/>
  <circle cx="950" cy="200" r="270" fill="#006eff" fill-opacity=".12" filter="url(#soft)"/>
  <circle cx="80" cy="1620" r="280" fill="#00d9ff" fill-opacity=".08" filter="url(#soft)"/>
  ${line(54, 88, 1026, 88, '#2ae4ff', .8, 2)}
  ${text(72, 58, 'OMEGA // LIVE CANVAS', 16, '#63edff', 700)}
  ${text(1008, 58, data.version, 16, '#5bffcf', 700, 'end')}
  ${text(72, 152, '𝗢 𝗠 𝗘 𝗚 𝗔  𝄜  𝗡 𝗔 𝗩 𝗜 𝗚 𝗔 𝗧 𝗜 𝗢 𝗡', 34, '#f1fdff', 700)}
  ${text(74, 188, `Status: ${data.status}  •  Prefix: ${data.prefix}`, 18, '#72d8e8', 500)}

  ${card(54, 220, 552, 454, '#14dfff')}
  ${card(630, 220, 396, 454, '#4b7dff')}
  ${text(84, 270, 'OPERATOR PROFILE', 15, '#5e9eaf', 700)}
  <clipPath id="profileClip"><circle cx="220" cy="420" r="112"/></clipPath>
  <circle cx="220" cy="420" r="118" fill="#06131e" stroke="#1adfff" stroke-width="4" stroke-opacity=".8"/>
  ${data.profilePicture ? `<image href="${data.profilePicture}" x="108" y="308" width="224" height="224" preserveAspectRatio="xMidYMid slice" clip-path="url(#profileClip)"/>` : `${text(220, 414, 'PROFILE', 18, '#72d8e8', 700, 'middle')}${text(220, 445, 'PICTURE', 14, '#42717d', 500, 'middle')}`}
  <circle cx="220" cy="420" r="136" fill="none" stroke="#4b7dff" stroke-width="2" stroke-dasharray="8 16" opacity=".8" filter="url(#glow)"/>
  ${text(378, 355, data.botName, 25, '#f1fdff', 700)}
  ${text(378, 395, 'AI CONTROL CENTER', 14, '#62edff', 700)}
  ${text(378, 455, 'REQUESTED BY', 13, '#5e9eaf', 700)}
  ${text(378, 484, truncate(data.userName, 20), 20, '#d9fbff', 500)}
  ${text(378, 536, 'USER ID', 13, '#5e9eaf', 700)}
  ${text(378, 565, truncate(data.userId, 20), 17, '#d9fbff', 500)}
  ${text(84, 628, `SESSION  ${truncate(data.session, 27)}`, 15, '#8dbac3', 600)}
  ${text(510, 628, `PREMIUM  ${data.premium}`, 15, '#5bffcf', 700, 'end')}

  ${text(660, 270, 'SYSTEM STATUS', 15, '#7292ff', 700)}
  ${statusMarkup}

  ${text(72, 728, 'NAVIGATION MODULES', 15, '#5e9eaf', 700)}
  ${navMarkup}

  ${card(54, 1410, 972, 292, '#14dfff')}
  ${text(84, 1460, 'RUNTIME TELEMETRY', 15, '#5e9eaf', 700)}
  ${text(84, 1522, 'SESSION', 15, '#5e9eaf', 700)}${text(330, 1522, data.session, 22, '#d9fbff', 600)}
  ${text(84, 1572, 'PREMIUM', 15, '#5e9eaf', 700)}${text(330, 1572, data.premium, 22, '#5bffcf', 700)}
  ${text(84, 1622, 'RUNTIME', 15, '#5e9eaf', 700)}${text(330, 1622, data.runtime, 22, '#d9fbff', 600)}
  ${text(650, 1522, 'VERSION', 15, '#5e9eaf', 700)}${text(930, 1522, data.version, 22, '#d9fbff', 600, 'end')}
  ${text(650, 1572, 'PLATFORM', 15, '#5e9eaf', 700)}${text(930, 1572, data.platform, 22, '#d9fbff', 600, 'end')}
  ${text(650, 1622, 'PREFIX', 15, '#5e9eaf', 700)}${text(930, 1622, data.prefix, 22, '#d9fbff', 600, 'end')}

  <rect x="54" y="1750" width="972" height="86" rx="18" fill="#0b2530" stroke="#14dfff" stroke-opacity=".75" stroke-width="2"/>
  ${text(84, 1803, '◆ PREMIUM // BUCKET CAPACITY  •  LIVE SYSTEM  •  ', 17, '#5bffcf', 700)}
  ${text(996, 1803, data.version, 17, '#d9fbff', 700, 'end')}
  ${text(540, 1878, '𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭', 22, '#62edff', 700, 'middle')}
</svg>`;
}

export async function generateMenuCanvas(options: MenuCanvasOptions): Promise<Buffer> {
  const svg = buildSvg(await canvasData(options));
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Resolve menu media with strict precedence:
 *   1. User-configured image/video (if its persisted file still exists)
 *   2. Generated live canvas image
 */
export async function resolveMenuMedia(options: MenuCanvasOptions): Promise<MenuCanvasMedia> {
  const configured = options.meta?.menuMedia;
  if (configured?.filePath && fs.existsSync(configured.filePath)) {
    try {
      return {
        buffer: fs.readFileSync(configured.filePath),
        type: configured.type,
        mimetype: configured.mimeType,
        caption: options.caption,
      };
    } catch {
      // A user media file can be removed externally between existsSync/readFileSync.
      // Fall back to the generated canvas rather than failing the menu send.
    }
  }

  return {
    buffer: await generateMenuCanvas(options),
    type: 'image',
    mimetype: 'image/png',
    caption: options.caption,
  };
}

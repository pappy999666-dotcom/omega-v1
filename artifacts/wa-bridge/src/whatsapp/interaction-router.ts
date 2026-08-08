// ============================================================
// WA-Bridge — Central Interaction Router
//
// Single router for EVERY interactive reply WhatsApp sends back:
//
//   User taps a native-flow button / native list row
//     → WhatsApp interactive reply (arrives as messages.upsert)
//     → parseInteraction()   (all reply types, deep unwrap)
//     → routeInteraction()   (dispatch to the requested handler)
//
// Supported reply types (verified in the installed
// @crysnovax/baileys 2.7.0 fork + WAProto definitions):
//   • interactiveResponseMessage.nativeFlowResponseMessage.paramsJson
//   • listResponseMessage.singleSelectReply.selectedRowId
//   • buttonsResponseMessage.selectedButtonId
//   • templateButtonReplyMessage.selectedId
//
// Routing ids:
//   menu:home:<m|g>                 → navigation hub (native list)
//   menu:cat:<m|g>:<navId>[:page]   → category page (native list)
//   menu:help:<m|g>:<page>          → paginated help (buttons)
//   cmd:<m|g>:<navId>:<command>     → single-command help card
//   run:ping                        → native ping table
//
// No command parses interactive replies on its own — everything
// funnels through this module.
// ============================================================

import type { BridgeWASocket as WASocket, WebMessageInfo, IMessage } from './baileys-types.js';
import { loadSessionConfig, loadSessionMeta } from '../services/workspace.js';
import { resolveMenuMedia } from '../services/menu-canvas.js';
import { PreviewManager } from '../preview-engine/index.js';
import { ALL_COMMANDS } from './command-parser.js';
import {
  MENU_CATALOG,
  categorySheetButton,
  renderNavHub,
  navHubButtons,
  renderNavCategoryPage,
  helpPageText,
  navFor,
} from './menu-registry.js';
import { pingTableData } from './utils/native-rich.js';
import { pingCard } from '../utils/ascii-art.js';
import { logger } from '../utils/logger.js';

// ── Parsing ────────────────────────────────────────────────

export type InteractionKind = 'native-flow' | 'list' | 'buttons' | 'template';

export interface InteractionRequest {
  kind: InteractionKind;
  /** The button/row id (menu:*, cmd:*, run:*) or null when only a label echoed. */
  id: string | null;
  /** Human-readable label the user tapped (fallback matching). */
  displayText: string;
}

/** Every future-proof wrapper the fork's normalizeMessageContent() unwraps. */
const FUTURE_PROOF_WRAPPERS = [
  'associatedChildMessage',
  'botForwardedMessage',
  'botInvokeMessage',
  'botTaskMessage',
  'documentWithCaptionMessage',
  'editedMessage',
  'ephemeralMessage',
  'eventCoverImage',
  'groupMentionedMessage',
  'groupStatusMentionMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
  'limitSharingMessage',
  'lottieStickerMessage',
  'newsletterAdminProfileMessage',
  'newsletterAdminProfileMessageV2',
  'newsletterAdminProfileStatusMessage',
  'pollCreationMessageV4',
  'pollCreationOptionImageMessage',
  'questionMessage',
  'questionReplyMessage',
  'spoilerMessage',
  'statusAddYours',
  'statusMentionMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapMessage(message: unknown): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m = (message ?? {}) as Record<string, any>;
  for (const key of FUTURE_PROOF_WRAPPERS) {
    const inner = m[key] as Record<string, any> | undefined;
    if (inner?.message) m = inner.message as Record<string, any>;
  }
  return m;
}

/** paramsJson arrives as a JSON string; some clients double-encode it. */
function parseParamsJson(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' && v ? v : '';
}

/**
 * Detect and extract every supported interactive reply.
 * Returns null when the message is not an interactive reply.
 */
export function parseInteraction(message: IMessage | null | undefined): InteractionRequest | null {
  if (!message) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = unwrapMessage(message as any);

  // 1. Native-flow button press (quick_reply buttons / single_select sheets)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inter = m?.interactiveResponseMessage as any;
  const nf = inter?.nativeFlowResponseMessage;
  if (nf) {
    const params = parseParamsJson(nf.paramsJson);
    const id = str(params?.id);
    const displayText = str(params?.display_text) || str(inter?.body?.text);
    if (id || displayText) return { kind: 'native-flow', id: id || null, displayText };
  }

  // 2. Native list row selection (listMessage → singleSelectReply)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listReply = m?.listResponseMessage?.singleSelectReply as any;
  if (listReply) {
    const id = str(listReply.selectedRowId);
    const displayText = str(listReply.selectedDisplayText);
    if (id || displayText) return { kind: 'list', id: id || null, displayText };
  }

  // 3. Legacy buttons response
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buttonsReply = m?.buttonsResponseMessage as any;
  if (buttonsReply) {
    const id = str(buttonsReply.selectedButtonId);
    const displayText = str(buttonsReply.selectedDisplayText);
    if (id || displayText) return { kind: 'buttons', id: id || null, displayText };
  }

  // 4. Hydrated-template button reply
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const templateReply = m?.templateButtonReplyMessage as any;
  if (templateReply) {
    const id = str(templateReply.selectedId);
    const displayText = str(templateReply.selectedDisplayText);
    if (id || displayText) return { kind: 'template', id: id || null, displayText };
  }

  return null;
}

// ── Dispatch ───────────────────────────────────────────────

export interface InteractionContext {
  socket: WASocket;
  sessionId: string;
  telegramId: string;
  msg: WebMessageInfo;
  interaction: InteractionRequest;
  /** Is the session frozen? (passed in to avoid an import cycle) */
  frozen?: boolean;
}

const targetTag = (menuTarget: 'main' | 'group'): string => (menuTarget === 'group' ? 'g' : 'm');
const targetFromTag = (tag: string | undefined): 'main' | 'group' => (tag === 'g' ? 'group' : 'main');

const quickReply = (displayText: string, id: string): { name: string; buttonParamsJson: string } => ({
  name: 'quick_reply',
  buttonParamsJson: JSON.stringify({ display_text: displayText, id }),
});

/** Send a menu/help body with optional native buttons + menu media. */
async function sendMenuResponse(
  ctx: InteractionContext,
  body: string,
  navButtons?: { name: string; buttonParamsJson: string }[],
  enableButtons = true,
  textOnly = false
): Promise<void> {
  const { socket, sessionId, telegramId, msg } = ctx;
  const meta = loadSessionMeta(telegramId, sessionId);
  const groupJid = msg.key.remoteJid ?? '';
  const options: any = {
    quoted: msg,
    sessionId,
    telegramId,
    enableButtons, // Plain-text help pages explicitly disable buttons.
  };
  if (navButtons?.length) options.extra = { buttons: navButtons };
  if (!textOnly) {
    const media = await resolveMenuMedia({
      prefix: loadSessionConfig(telegramId, sessionId).prefix,
      menuTarget: groupJid.endsWith('@g.us') ? 'group' : 'main',
      status: 'ONLINE',
      userName: msg.pushName || undefined,
      caption: body,
      config: loadSessionConfig(telegramId, sessionId),
      meta,
      socket,
    });
    options.media = {
      buffer: media.buffer,
      type: media.type,
      mimetype: media.mimetype,
      caption: media.caption,
    };
  }
  await PreviewManager.send(socket as never, groupJid, body, options);
}

/** Navigation hub: compact text + one native quick_reply per category. */
async function renderHub(ctx: InteractionContext, menuTarget: 'main' | 'group'): Promise<void> {
  const { sessionId, telegramId } = ctx;
  const config = loadSessionConfig(telegramId, sessionId);
  await sendMenuResponse(ctx, renderNavHub(config.prefix, menuTarget, ALL_COMMANDS), navHubButtons(menuTarget));
}

/**
 * Category page: compact text + a native single_select command sheet
 * (interactive table) + visible Prev/Next/Home quick_replies.
 */
async function renderCategory(
  ctx: InteractionContext,
  navId: string,
  page: number,
  menuTarget: 'main' | 'group'
): Promise<void> {
  const { sessionId, telegramId } = ctx;
  const config = loadSessionConfig(telegramId, sessionId);
  const sheet = categorySheetButton(config.prefix, menuTarget, navId, page, ALL_COMMANDS);
  if (sheet.totalPages === 0) {
    // Unknown or empty category — back to the hub.
    await renderHub(ctx, menuTarget);
    return;
  }
  const text = renderNavCategoryPage(config.prefix, navId, page, menuTarget, ALL_COMMANDS);
  await sendMenuResponse(ctx, text.text, sheet.buttons);
}

/** Plain-text help page; page navigation is sent inside the text body. */
async function renderHelp(ctx: InteractionContext, page: number, _menuTarget: 'main' | 'group'): Promise<void> {
  const { sessionId, telegramId } = ctx;
  const config = loadSessionConfig(telegramId, sessionId);
  const res = helpPageText(config.prefix, page, 'all', ALL_COMMANDS);
  await sendMenuResponse(ctx, res.text, undefined, false, true);
}

/** Single-command detail card with a Back button to its category. */
async function renderCommandHelp(ctx: InteractionContext, parts: string[]): Promise<boolean> {
  const menuTarget = targetFromTag(parts[1]);
  const navId = parts[2];
  const cmdName = parts.slice(3).join(':');
  if (!cmdName || !MENU_CATALOG[cmdName]) return false;
  const { sessionId, telegramId } = ctx;
  const config = loadSessionConfig(telegramId, sessionId);
  const { generateWhatsAppHelp } = await import('../services/help.js');
  const detail = generateWhatsAppHelp(config.prefix, menuTarget === 'group', cmdName);
  const back = navId
    ? [quickReply('⬅️ Back', `menu:cat:${targetTag(menuTarget)}:${navId}`)]
    : undefined;
  await sendMenuResponse(ctx, detail, back);
  return true;
}

/** Run a whitelisted command from a table row (currently: ping). */
async function runCommand(ctx: InteractionContext, id: string): Promise<boolean> {
  if (id !== 'run:ping') return false;
  const { socket, sessionId, telegramId, msg, frozen } = ctx;
  const groupJid = msg.key.remoteJid ?? '';

  const startTime = Date.now();
  let latencyMs = 0;
  try {
    await socket.sendMessage(groupJid, { react: { text: '⚡', key: msg.key } });
    latencyMs = Date.now() - startTime;
  } catch {
    const ts = Number(msg.messageTimestamp ?? 0);
    if (ts > 0) latencyMs = Math.min(Math.max(Date.now() - ts * 1000, 0), 99999);
  }

  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);
  const status = frozen ? 'FROZEN' : 'ONLINE';
  const runtime = `${h}h ${m}m ${s}s`;
  const ram = `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB`;

  const card = pingCard({
    latency: latencyMs,
    sessionId,
    status,
    runtime,
    ram,
    platform: process.platform,
    version: '1.0.0',
  });

  await PreviewManager.send(socket as never, groupJid, card, {
    nativeTable: pingTableData(sessionId, status, {
      latencyMs,
      runtime,
      ram,
      platform: process.platform,
      version: '1.0.0',
    }),
    tableFallbackText: card,
    quoted: msg,
    sessionId,
    telegramId,
  });
  return true;
}

/** Fallback: client echoed only the display text (no id) — match hub labels. */
function matchDisplayText(displayText: string): string | null {
  if (!displayText) return null;
  const cleaned = displayText.replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
  if (!cleaned) return null;
  for (const target of ['main', 'group'] as const) {
    const nav = navFor(target).find((n) => n.label.toLowerCase() === cleaned);
    if (nav) return `menu:cat:${targetTag(target)}:${nav.id}`;
  }
  if (cleaned === 'help') return 'menu:help:m:1';
  if (cleaned === 'menu' || cleaned === 'home') return 'menu:home:m';
  return null;
}

/**
 * Route an interactive reply to its handler.
 * Returns true when the reply was handled (message consumed).
 */
export async function routeInteraction(ctx: InteractionContext): Promise<boolean> {
  const { interaction } = ctx;
  let id = interaction.id;

  // Clients that only echo display_text (no id) — resolve via label.
  if (!id) id = matchDisplayText(interaction.displayText);
  if (!id) {
    logger.debug('[Interaction] unhandled reply', {
      kind: interaction.kind,
      displayText: interaction.displayText,
    });
    return false;
  }

  if (id.startsWith('menu:')) {
    const parts = id.split(':');
    const menuTarget = targetFromTag(parts[2] ?? 'm');
    if (parts[1] === 'home') {
      await renderHub(ctx, menuTarget);
    } else if (parts[1] === 'cat') {
      await renderCategory(ctx, parts[3] ?? '', Number(parts[4]) || 1, menuTarget);
    } else if (parts[1] === 'help') {
      await renderHelp(ctx, Number(parts[3]) || 1, menuTarget);
    } else {
      return false;
    }
    return true;
  }

  if (id.startsWith('cmd:')) {
    return renderCommandHelp(ctx, id.split(':'));
  }

  if (id.startsWith('run:')) {
    return runCommand(ctx, id);
  }

  logger.debug('[Interaction] unknown id', { kind: interaction.kind, id });
  return false;
}

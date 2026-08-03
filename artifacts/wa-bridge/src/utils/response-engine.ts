// ============================================================
// WA-Bridge — Shared Response Template Engine
// Centralised variable parser used by every feature that sends
// formatted messages: Anti System, moderation commands,
// welcome/goodbye events, and custom response templates.
//
// Supported variables:
//   @mention       → @<phone_number>
//   &gcname        → group subject
//   &desc          → group description
//   &getpp         → sender profile picture URL
//   &membercount   → current member count
//   &admincount    → current admin count
//   &date          → current date (locale string)
//   &time          → current time (locale string)
// ============================================================

import type { BridgeWASocket as WASocket } from '../whatsapp/baileys-types.js';
import { fetchGroupMeta } from '../whatsapp/utils/group-permissions.js';

export interface ResponseContext {
  senderJid: string;
  gcName: string;
  socket: WASocket;
  groupJid: string;
}

/**
 * Render a response template string, substituting all supported variables.
 * Async because &desc, &getpp, &membercount, &admincount may require network calls.
 */
export async function renderTemplate(
  template: string,
  ctx: ResponseContext
): Promise<string> {
  const { senderJid, gcName, socket, groupJid } = ctx;
  const phone = senderJid.split('@')[0]?.split(':')[0] ?? 'User';
  const now = new Date();

  let result = template;

  // ── Synchronous substitutions ─────────────────────────────
  // Standard variables
  result = result.replace(/@mention/gi, `@${phone}`);
  result = result.replace(/&gcname/gi, gcName);
  result = result.replace(/&date/gi,
    now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  );
  result = result.replace(/&time/gi,
    now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  );

  // User requested aliases
  result = result.replace(/@user/gi, `@${phone}`);
  result = result.replace(/@group/gi, gcName);

  // ── Group metadata (single fetch for desc + counts) ───────
  const needsMeta = result.includes('&desc') || result.includes('&membercount') || result.includes('&admincount') || result.includes('@count');
  if (needsMeta) {
    try {
      const meta = await fetchGroupMeta(socket, groupJid);

      result = result.replace(/&desc/gi, meta?.desc ?? '');
      result = result.replace(/&membercount/gi, String(meta?.participants.length ?? 0));
      result = result.replace(/@count/gi, String(meta?.participants.length ?? 0));
      result = result.replace(/&admincount/gi,
        String(meta?.participants.filter((p) => p.admin).length ?? 0)
      );
    } catch {
      result = result.replace(/&desc/gi, '');
      result = result.replace(/&membercount/gi, '?');
      result = result.replace(/@count/gi, '?');
      result = result.replace(/&admincount/gi, '?');
    }
  }

  // ── Profile picture URL ───────────────────────────────────
  if (result.includes('&getpp')) {
    try {
      const ppUrl = await (socket as unknown as {
        profilePictureUrl(jid: string, type: string): Promise<string>;
      }).profilePictureUrl(senderJid, 'image');
      result = result.replace(/&getpp/gi, ppUrl ?? '');
    } catch {
      result = result.replace(/&getpp/gi, '');
    }
  }

  return result;
}

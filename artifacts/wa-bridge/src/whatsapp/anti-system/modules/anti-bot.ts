// ============================================================
// Anti System — AntiBot Module
// Detects likely automation clients using Baileys metadata.
// Does NOT flag: Android, iPhone, iPad, official linked devices.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

/**
 * Known bot/automation platform user-agent strings or device names
 * that appear in Baileys verifiedBizName or similar fields.
 */
const BOT_PLATFORM_HINTS = [
  'baileys',
  'wa-automate',
  'whatsapp-web',
  'yowsjs',
  'go-whatsapp',
  'multidevice',
  'wwebjs',
  'node',
  'python',
  'bot',
  'auto',
  'automation',
];

/**
 * Heuristics to detect automation clients:
 *
 * 1. Message key ID is 3EB... — this is a Baileys/web-generated key pattern
 *    (real mobile keys are random alphanumeric, not 3EB-prefixed).
 * 2. verifiedBizName contains bot hints.
 * 3. Message is from a non-standard agent (agent field in JID > 0 is linked device,
 *    agent = 0 is primary — automation clients often spoof agent 0).
 * 4. Device name from participant JID agent field patterns.
 *
 * NOTE: We keep false-positive rate very low. If uncertain, we return false.
 */
export function messageIsFromBot(msg: WebMessageInfo): boolean {
  // Only check incoming messages (not fromMe)
  if (msg.key.fromMe) return false;

  const msgId = msg.key.id ?? '';
  const participant = msg.key.participant ?? '';

  // 1. Baileys / WhatsApp Web generate IDs starting with "3EB"
  //    Mobile clients use alphanumeric IDs of length 16-22 without this prefix.
  if (msgId.startsWith('3EB') && msgId.length > 10) {
    return true;
  }

  // 2. Baileys occasionally exposes device platform info
  const bizName = (msg as unknown as { verifiedBizName?: string }).verifiedBizName ?? '';
  if (bizName && BOT_PLATFORM_HINTS.some((h) => bizName.toLowerCase().includes(h))) {
    return true;
  }

  // 3. Check agent index in participant JID — linked devices use agent > 0
  //    Primary device (mobile) agent = 0; we allow linked devices (agent > 0)
  //    Automation clients often use agent = 0 with web-like IDs
  const agentMatch = participant.match(/:(\d+)@/);
  if (agentMatch) {
    const agent = parseInt(agentMatch[1] ?? '0', 10);
    // Agent 0 with 3EB ID already caught above.
    // Agent > 100 is suspicious (normal devices use 0-5).
    if (agent > 100) return true;
  }

  // 4. Message ID length check — real mobile IDs are 16-22 chars
  //    Very short (< 8) or very long (> 40) IDs are atypical
  if (msgId.length > 0 && (msgId.length < 6 || msgId.length > 50)) {
    return true;
  }

  return false;
}

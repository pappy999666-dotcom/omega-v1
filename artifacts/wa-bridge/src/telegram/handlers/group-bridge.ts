// ============================================================
// WA-Bridge — Per-Group Bridge Mode State Manager
// Tracks which session + group JID each Telegram user has
// currently bridged to. Fully isolated per Telegram user.
// ============================================================

export interface GroupBridgeState {
  sessionId: string;
  gcJid: string;
  gcName: string;
}

/** In-memory map: telegramId → active group bridge */
const groupBridgeMap = new Map<string, GroupBridgeState>();

export function setGroupBridge(
  telegramId: string,
  sessionId: string,
  gcJid: string,
  gcName: string
): void {
  groupBridgeMap.set(telegramId, { sessionId, gcJid, gcName });
}

export function getGroupBridge(telegramId: string): GroupBridgeState | undefined {
  return groupBridgeMap.get(telegramId);
}

export function clearGroupBridge(telegramId: string): void {
  groupBridgeMap.delete(telegramId);
}

export function isGroupBridgeActive(telegramId: string): boolean {
  return groupBridgeMap.has(telegramId);
}

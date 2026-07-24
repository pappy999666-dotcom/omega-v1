import { getAllSockets } from '../whatsapp/socket-manager.js';
import { loadAllSessions, getAllUserIds, updateSessionMeta } from './workspace.js';
import { logger } from '../utils/logger.js';

export async function postAutoPromoteNow(sessionId: string, groupJid: string, socket: { sendMessage(jid: string, content: { text: string }): Promise<unknown> }, message?: string): Promise<void> {
  const meta = getAllUserIds().flatMap((id) => Object.values(loadAllSessions(id))).find((session) => session.sessionId === sessionId);
  const settings = meta?.autoPromote;
  if (!settings?.enabled) return;
  const text = (message || settings.message || '').trim();
  if (!text) return;
  await socket.sendMessage(groupJid, { text });
}

export function startAutoPromoteScheduler(): NodeJS.Timeout {
  const timer = setInterval(async () => {
    const sockets = getAllSockets();
    for (const [sessionId, handle] of sockets.entries()) {
      const settings = handle.meta.autoPromote;
      if (!settings?.enabled || !settings.message.trim()) continue;
      const due = !settings.lastPostedAt || Date.now() - settings.lastPostedAt >= settings.intervalMinutes * 60_000;
      if (!due) continue;
      try {
        const groups = await (handle.socket as unknown as { groupFetchAllParticipating(): Promise<Record<string, { id: string }>> }).groupFetchAllParticipating();
        for (const group of Object.values(groups)) await handle.socket.sendMessage(group.id, { text: settings.message });
        updateSessionMeta(handle.meta.telegramId, sessionId, { autoPromote: { ...settings, lastPostedAt: Date.now() } });
      } catch (error) {
        logger.warn('[AutoPromote] Scheduled post failed', { sessionId, error: String(error) });
      }
    }
  }, 60_000);
  timer.unref();
  return timer;
}

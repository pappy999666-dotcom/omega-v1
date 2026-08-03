import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { 
  getSocket, 
  getAllSockets, 
  reinitSocket, 
  closeSocket, 
  markPurged, 
  freezeSession, 
  unfreezeSession 
} from '../socket-manager.js';
import { 
  loadAllSessions, 
  loadSessionMeta, 
  updateSessionMeta, 
  purgeSession 
} from '../../services/workspace.js';
import { 
  successCard, 
  warningCard, 
  errorCard, 
  asciiBox, 
  sessionBox,
  bold
} from '../../utils/ascii-art.js';

const MODULE = 'SESSION MANAGER';

export async function cmdListSessions(telegramId: string): Promise<string> {
  const sessions = loadAllSessions(telegramId);
  const ids = Object.keys(sessions);
  
  if (ids.length === 0) {
    return warningCard('NO SESSIONS', 'You have no active or saved WhatsApp sessions.', [], MODULE);
  }

  const rows: [string, string][] = ids.map(id => {
    const meta = sessions[id]!;
    const status = meta.status.toUpperCase();
    const emoji = status === 'OPEN' ? '🟢' : status === 'FROZEN' ? '❄️' : '🔴';
    return [id, `${emoji} ${status}`];
  });

  return asciiBox({
    title: 'WHATSAPP SESSIONS',
    emoji: '📱',
    rows,
    footer: `Total: ${ids.length} session(s)`,
    moduleIdentity: MODULE
  });
}

export async function cmdSessionInfo(telegramId: string, sessionId: string): Promise<string> {
  const meta = loadSessionMeta(telegramId, sessionId);
  if (!meta) return errorCard('SESSION NOT FOUND', `No metadata for session: ${sessionId}`, undefined, MODULE);
  
  const socket = getSocket(sessionId);
  const allSockets = getAllSockets();
  
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);
  
  return sessionBox({
    sessionId: meta.sessionId,
    phone: meta.phone,
    status: meta.status,
    groups: meta.linksCollected ?? 0,
    connectedSessions: allSockets.size,
    device: (socket as any)?.user?.name || (socket as any)?.user?.id || 'Unknown',
    node: process.version,
    workspace: 'OMEGA-V1',
    runtime: `${h}h ${m}m ${s}s`,
    memory: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB`,
    version: '1.0.0',
    lastReconnect: meta.lastSeen ? new Date(meta.lastSeen).toLocaleString() : 'Never'
  });
}

export async function cmdRestartSession(telegramId: string, sessionId: string): Promise<string> {
  const meta = loadSessionMeta(telegramId, sessionId);
  if (!meta) return errorCard('RESTART FAILED', `Session ${sessionId} not found.`, undefined, MODULE);
  
  try {
    await reinitSocket(meta);
    return successCard('SESSION RESTARTED', `Session ${bold(sessionId)} is reconnecting...`, [], MODULE);
  } catch (err) {
    return errorCard('RESTART FAILED', `Could not restart ${sessionId}`, String(err), MODULE);
  }
}

export async function cmdDisconnectSession(telegramId: string, sessionId: string): Promise<string> {
  const socket = getSocket(sessionId);
  if (!socket) return warningCard('NOT CONNECTED', `Session ${sessionId} is not currently active.`, [], MODULE);
  
  try {
    await closeSocket(sessionId);
    updateSessionMeta(telegramId, sessionId, { status: 'closed' });
    return successCard('DISCONNECTED', `Session ${bold(sessionId)} has been closed.`, [], MODULE);
  } catch (err) {
    return errorCard('DISCONNECT FAILED', `Could not close ${sessionId}`, String(err), MODULE);
  }
}

export async function cmdDeleteSession(telegramId: string, sessionId: string): Promise<string> {
  try {
    markPurged(sessionId);
    await closeSocket(sessionId);
    await purgeSession(telegramId, sessionId);
    return successCard('SESSION DELETED', `Session ${bold(sessionId)} and all its data have been removed.`, [], MODULE);
  } catch (err) {
    return errorCard('DELETE FAILED', `Could not purge ${sessionId}`, String(err), MODULE);
  }
}

export async function cmdRenameSession(telegramId: string, sessionId: string, newLabel: string): Promise<string> {
  const meta = loadSessionMeta(telegramId, sessionId);
  if (!meta) return errorCard('RENAME FAILED', `Session ${sessionId} not found.`, undefined, MODULE);
  
  updateSessionMeta(telegramId, sessionId, { label: newLabel });
  return successCard('SESSION RENAMED', `Session ${bold(sessionId)} is now labeled: ${bold(newLabel)}`, [], MODULE);
}

export async function cmdFreezeSession(sessionId: string): Promise<string> {
  freezeSession(sessionId);
  return successCard('SESSION FROZEN', `Session ${bold(sessionId)} will ignore all incoming events.`, [], MODULE);
}

export async function cmdUnfreezeSession(sessionId: string): Promise<string> {
  unfreezeSession(sessionId);
  return successCard('SESSION UNFROZEN', `Session ${bold(sessionId)} is now active.`, [], MODULE);
}

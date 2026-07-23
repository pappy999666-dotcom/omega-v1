import crypto from 'crypto';
import { STATUS_THEMES, type StatusTheme } from './StatusDesignEngine.js';
import { logger } from '../utils/logger.js';

export interface DesignCampaign {
  id: string;
  assignments: ReadonlyMap<string, StatusTheme>;
  themeFor(groupJid: string): StatusTheme;
}

function shuffledThemes(seed: string): StatusTheme[] {
  return [...STATUS_THEMES]
    .map((theme) => ({ theme, score: crypto.createHash('sha256').update(`${seed}:${theme}`).digest('hex') }))
    .sort((a, b) => a.score.localeCompare(b.score))
    .map(({ theme }) => theme);
}

export class GCDesignAllocator {
  createCampaign(groupJids: string[], sticky: Record<string, StatusTheme> = {}): DesignCampaign {
    try {
      const uniqueJids = [...new Set(groupJids)];
      const id = crypto.randomUUID();
      const pool = shuffledThemes(id);
      const assignments = new Map<string, StatusTheme>();
      const used = new Set<StatusTheme>();

      for (const jid of uniqueJids) {
        const preferred = sticky[jid];
        if (preferred && !used.has(preferred)) {
          assignments.set(jid, preferred);
          used.add(preferred);
          continue;
        }

        const available = pool.find((theme) => !used.has(theme));
        // More than 20 targets cannot have globally unique themes. Start a new
        // deterministic visual cycle; each adjacent allocation remains distinct.
        const theme = available ?? pool[assignments.size % pool.length]!;
        assignments.set(jid, theme);
        used.add(theme);
      }

      return {
        id,
        assignments,
        themeFor(groupJid: string): StatusTheme {
          const theme = assignments.get(groupJid);
          if (!theme) throw new Error(`Group ${groupJid} is not part of campaign ${id}`);
          return theme;
        },
      };
    } catch (error) {
      logger.error('[GCDesignAllocator] Campaign allocation failed', { error: String(error) });
      throw error;
    }
  }
}

export const gcDesignAllocator = new GCDesignAllocator();

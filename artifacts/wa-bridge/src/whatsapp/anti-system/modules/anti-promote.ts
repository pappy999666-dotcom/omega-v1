// ============================================================
// Anti System — AntiPromote Module
// Monitors unauthorized admin promotions in group-participants.update.
// ============================================================

export interface ParticipantUpdate {
  id: string;
  action: 'add' | 'remove' | 'promote' | 'demote';
  participants: string[];
  author?: string; // who triggered the change
}

/** Returns participants involved in a promote event */
export function extractPromotedParticipants(update: ParticipantUpdate): string[] {
  if (update.action !== 'promote') return [];
  return update.participants;
}

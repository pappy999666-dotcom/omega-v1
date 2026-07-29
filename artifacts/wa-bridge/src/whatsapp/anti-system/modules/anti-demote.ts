// ============================================================
// Anti System — AntiDemote Module
// Handles unauthorized admin demotions with configurable modes.
//
// Modes:
//   dwp — demote the responsible admin, do NOT restore victim
//   dnp — demote the responsible admin, restore victim
//   kwp — kick the responsible admin, do NOT restore victim
//   knp — kick the responsible admin, restore victim
// ============================================================

export { demoteParticipant, promoteParticipant, kickParticipant } from '../actions.js';

export interface ParticipantUpdate {
  id: string;
  action: 'add' | 'remove' | 'promote' | 'demote';
  participants: string[];
  author?: string; // who triggered the demote
}

/** Returns participants involved in a demote event */
export function extractDemotedParticipants(update: ParticipantUpdate): string[] {
  if (update.action !== 'demote') return [];
  return update.participants;
}

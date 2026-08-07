import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { resolveIdentity } from './identity.js';
import type { GroupParticipant } from './group-permissions.js';

export interface PendingJoinRequest {
  jid: string;
  phoneNumber?: string;
  phone_number?: string;
}

/**
 * Return only pending requests whose real phone identity starts with the
 * requested country code. Unresolved LIDs fail closed and are never treated
 * as phone numbers.
 */
export async function filterPendingRequestsByCountry(
  socket: WASocket,
  requests: PendingJoinRequest[],
  participants: GroupParticipant[],
  countryDigits: string
): Promise<PendingJoinRequest[]> {
  const code = countryDigits.replace(/\D/g, '');
  if (!code) return [];

  const matched: PendingJoinRequest[] = [];
  for (const request of requests) {
    const explicitPhone = (request.phone_number ?? request.phoneNumber ?? '').replace(/\D/g, '');
    const identity = explicitPhone
      ? { number: explicitPhone }
      : await resolveIdentity(socket, request.jid, participants);
    if (identity.number.startsWith(code)) matched.push(request);
  }
  return matched;
}

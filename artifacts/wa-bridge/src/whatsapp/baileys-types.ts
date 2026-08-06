import type { WASocket as BaseWASocket, WAMessageKey } from '@crysnovax/baileys';

export type AnyMessageContent = Record<string, unknown>;

export interface GroupMetadata {
  id: string;
  subject: string;
  participants: { id: string; admin?: string | null }[];
  desc?: string;
  size?: number;
}

export interface InviteInfo {
  id: string;
  subject?: string;
  size?: number;
  desc?: string;
}

export interface AuthState {
  creds: { registered?: boolean };
  keys: unknown;
}

export interface EventEmitterLike {
  on(event: string, listener: (data: unknown) => void): void;
  removeAllListeners(): void;
}

export interface BridgeWASocket extends BaseWASocket {
  ev: EventEmitterLike;
  authState: AuthState;
  requestPairingCode(phone: string, code?: string): Promise<string>;
  groupAcceptInvite(code: string): Promise<string>;
  groupGetInviteInfo(code: string): Promise<InviteInfo>;
  groupFetchAllParticipating(): Promise<Record<string, GroupMetadata>>;
  groupMetadata(jid: string): Promise<GroupMetadata>;
  groupLeave(jid: string): Promise<void>;
  end(error?: Error): void;
  sendMessage(jid: string | string[], content: AnyMessageContent, options?: Record<string, unknown>): Promise<{ key?: WAMessageKey } | unknown>;
}

export interface BaileysEventMap {
  'messages.upsert': unknown;
  'messages.update': unknown;
  'messages.media-update': unknown;
  'messages.delete': unknown;
  'messages.reaction': unknown;
  'messages.receipt-update': unknown;
  'message-receipt.update': unknown;
  'groups.update': unknown;
  'group-participants.update': unknown;
  'presence.update': unknown;
  'contacts.update': unknown;
  'contacts.upsert': unknown;
  'chats.set': unknown;
  'chats.update': unknown;
  'chats.delete': unknown;
  'messaging-history.set': unknown;
  'creds.update': unknown;
  'connection.update': unknown;
  'call': unknown;
  'blocklist.set': unknown;
  'blocklist.update': unknown;
  'labels.association': unknown;
  'labels.edit': unknown;
  'product.update': unknown;
  'status.update': unknown;
  'sticker.update': unknown;
  'newsletter.update': unknown;
  'newsletter.mute': unknown;
  'newsletter.reaction': unknown;
  'newsletter.follow': unknown;
  'newsletter.join': unknown;
  'newsletter.leave': unknown;
  'newsletter.view': unknown;
  'newsletter.delete': unknown;
  'newsletter.ephemeral': unknown;
  'chat-update': unknown;
}

export interface WebMessageInfo {
  key: WAMessageKey;
  message?: IMessage | null;
  messageTimestamp?: number | LongLike;
  pushName?: string | null;
}

export interface LongLike { low?: number; high?: number; unsigned?: boolean; }

export interface MessageContextInfo {
  mentionedJid?: string[] | null;
  quotedMessage?: IMessage | null;
  /** JID of the quoted message's original sender (populated in group messages) */
  participant?: string | null;
  /** Alternate (real) JID of the quoted sender — populated for LID accounts by the fork */
  participantAlt?: string | null;
  /** Stanza ID of the quoted message */
  stanzaId?: string | null;
  /** Remote JID the quoted message belongs to */
  remoteJid?: string | null;
  /** True for real group-status posts (groupStatusMessage*) */
  isGroupStatus?: boolean;
  /** Channel-source metadata for forwarded channel messages */
  forwardedNewsletterMessageInfo?: Record<string, unknown> | null;
}

export interface IMessage {
  conversation?: string | null;
  extendedTextMessage?: {
    text?: string | null;
    matchedText?: string | null;
    title?: string | null;
    description?: string | null;
    jpegThumbnail?: Uint8Array | null;
    canonicalUrl?: string | null;
    contextInfo?: MessageContextInfo | null;
  } | null;
  imageMessage?: { caption?: string | null; contextInfo?: MessageContextInfo | null } | null;
  videoMessage?: { caption?: string | null; contextInfo?: MessageContextInfo | null } | null;
  audioMessage?: { caption?: string | null; contextInfo?: MessageContextInfo | null; ptt?: boolean | null } | null;
  documentMessage?: { caption?: string | null; contextInfo?: MessageContextInfo | null } | null;
  stickerMessage?: { fileSha256?: Uint8Array | null; contextInfo?: MessageContextInfo | null; isAnimated?: boolean | null } | null;
  ephemeralMessage?: { message?: IMessage | null } | null;
  viewOnceMessage?: { message?: IMessage | null } | null;
  viewOnceMessageV2?: { message?: IMessage | null } | null;
  viewOnceMessageV2Extension?: { message?: IMessage | null } | null;
  documentWithCaptionMessage?: { message?: IMessage | null } | null;
  buttonsMessage?: { contentText?: string | null; contextInfo?: MessageContextInfo | null } | null;
  buttonsResponseMessage?: { selectedButtonId?: string | null } | null;
  listMessage?: { description?: string | null; title?: string | null; contextInfo?: MessageContextInfo | null } | null;
  listResponseMessage?: { singleSelectReply?: { selectedRowId?: string | null } | null } | null;
  templateMessage?: { hydratedTemplate?: { hydratedContentText?: string | null } | null; contextInfo?: MessageContextInfo | null } | null;
  interactiveMessage?: { contextInfo?: MessageContextInfo | null } | null;
  contactMessage?: { contextInfo?: MessageContextInfo | null } | null;
  locationMessage?: { contextInfo?: MessageContextInfo | null } | null;
  reactionMessage?: { text?: string | null; key?: Record<string, unknown> | null } | null;
  protocolMessage?: { type?: number | null; key?: Record<string, unknown> | null } | null;
  pollCreationMessage?: { name?: string | null; contextInfo?: MessageContextInfo | null } | null;
  pollCreationMessageV2?: { name?: string | null } | null;
  pollCreationMessageV3?: { name?: string | null } | null;
  pollUpdateMessage?: { pollEncryptedV1?: Record<string, unknown> | null; voterEncryptedV1?: unknown | null } | null;
  groupStatusMessage?: { message?: IMessage | null; contextInfo?: MessageContextInfo | null } | null;
  groupStatusMessageV2?: { message?: IMessage | null; contextInfo?: MessageContextInfo | null } | null;
  groupMentionMessage?: { contextInfo?: MessageContextInfo | null } | null;
  keepInChatMessage?: { key?: Record<string, unknown> | null; keepInChatType?: number | null } | null;
  editedMessage?: { message?: IMessage | null; edits?: Array<Record<string, unknown>> | null } | null;
}

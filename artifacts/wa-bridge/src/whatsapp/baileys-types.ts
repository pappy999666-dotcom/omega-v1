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
  'groups.update': unknown;
  'group-participants.update': unknown;
  'presence.update': unknown;
  'contacts.update': unknown;
  'creds.update': unknown;
  'connection.update': unknown;
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
  documentMessage?: { caption?: string | null } | null;
  stickerMessage?: { fileSha256?: Uint8Array | null } | null;
  ephemeralMessage?: { message?: IMessage | null } | null;
  viewOnceMessage?: { message?: IMessage | null } | null;
  viewOnceMessageV2?: { message?: IMessage | null } | null;
  documentWithCaptionMessage?: { message?: IMessage | null } | null;
}

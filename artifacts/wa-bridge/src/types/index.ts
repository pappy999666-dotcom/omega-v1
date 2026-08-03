// ============================================================
// WA-Bridge — Shared TypeScript Types
// ============================================================

export interface UserConfig {
  telegramId: string;
  username?: string;
  isBanned: boolean;
  isOwner: boolean;
  prefix: string;               // Custom command prefix
  nullPrefix: boolean;          // Always-listen mode
  stickerMacros: Record<string, string>; // sticker hash → command
  sudoNumbers?: string[];        // normalized WhatsApp numbers allowed to run commands
  defaultLinkCollection?: boolean;
  notificationsEnabled?: boolean;
  autoValidationEnabled?: boolean;
  sleeping?: boolean;
  statusDesignEnabled?: boolean; // unique per-GC designs for mass status campaigns
  statusDesignTheme?: string; // preferred theme for single-GC status designs
  statusDesignStickyThemes?: Record<string, string>; // group JID → preferred theme
  forceJoinTargets?: string[];
  broadcastEnabled?: boolean;
  joinedAt: number;
  lastActivity: number;
  publicMode?: boolean;
  tagReply?: boolean;
  permissionDeniedResponse?: string;
  stickerPackName?: string;
  stickerAuthor?: string;
  releaseChannelUsername?: string;
  releasePostsEnabled?: boolean;
}

export interface MenuButton {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  order: number;
}

export interface PlatformConfig {
  globalMenuButtons?: MenuButton[];
  /** @deprecated use globalMenuButtons */
  globalMenuUrl?: string;
  /** @deprecated use globalMenuButtons */
  globalMenuUrls?: string[];
  releaseChannelUsername?: string;
  releasePostsEnabled?: boolean;
}

export interface SessionMenuMedia {
  type: 'image' | 'video';
  filePath: string;
  mimeType: string;
}

export interface SessionMeta {
  sessionId: string;            // e.g. "1_{tg_id}_{phone}"
  telegramId: string;
  phone: string;
  label?: string;
  status: 'connecting' | 'open' | 'frozen' | 'dead' | 'purged' | 'banned' | 'error' | 'closed';
  pairMethod: 'qr' | 'code';
  pairedAt?: number;
  lastSeen?: number;
  errorCount: number;
  autoJoinDone: boolean;
  linkCollectionEnabled?: boolean;
  linksCollected?: number;
  joinManager?: JoinManagerState;
  joinSettings?: { maxLinksPerRun?: number; delayMs?: number };
  autoPromote?: AutoPromoteSettings;
  menuMedia?: SessionMenuMedia | null;
}

export interface AutoPromoteSettings {
  enabled: boolean;
  message: string;
  postOnJoin: boolean;
  intervalMinutes?: number;
  lastPostedAt?: number;
}

export interface AutoPromoteJob {
  sessionId: string;
  telegramId: string;
  links: string[];          // up to 24 links in queue order
  days: number;
  startedAt: number;
  endsAt: number;
  lastRanAt?: number;
  history: AutoPromoteRun[];
}

export interface AutoPromoteRun {
  at: number;
  slot: 'morning' | 'evening';
  link: string;             // which link was run
  linkIndex: number;        // position in queue
  success: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface JoinManagerState {
  status: 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'restricted';
  cursor: number;
  total: number;
  joined: number;
  skipped: number;
  failed: number;
  gcCount: number;
  consecutiveRestrictions: number;
  rateLimitHits: number;
  currentLink?: string;
  lastError?: string;
  startedAt?: number;
  updatedAt: number;
  logs: string[];
}

export interface BucketEntry {
  link: string;
  jid?: string;
  title?: string;
  memberCount?: number;
  thumbnailUrl?: string;
  addedAt: number;
  validatedAt?: number;
  status: 'unvalidated' | 'active' | 'dead';
  deadReason?: string;
  sourceSessionId?: string;
}

export interface Workspace {
  telegramId: string;
  config: UserConfig;
  sessions: Record<string, SessionMeta>;
  mainBucket: BucketEntry[];
  activeBucket: BucketEntry[];
  deadBucket: BucketEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface JobPayload {
  telegramId: string;
  sessionId: string;
  type: JobType;
  data: Record<string, unknown>;
  chatId?: number;              // Telegram chat for progress updates
  messageId?: number;           // Message to edit with status
}

export type JobType =
  | 'allstatus'
  | 'allchat'
  | 'sstatus'
  | 'joinall'
  | 'leaveall'
  | 'validate_links'
  | 'tochatx'
  | 'omni_bridge';

export interface JobResult {
  success: number;
  failed: number;
  skipped: number;
  rateLimited: number;
  details: string[];
  duration: number;
}

export interface CircuitState {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: number;
  openedAt?: number;
}

export interface ValidationResult {
  link: string;
  jid?: string;
  title?: string;
  memberCount?: number;
  description?: string;
  isValid: boolean;
  reason?: string;
  transient?: boolean;
}

export interface ParsedCommand {
  prefix: string;
  command: string;
  args: string[];
  rawRemainder: string;
  raw: string;
  fromSticker?: boolean;
  stickerHash?: string;
}

export interface TelegramContext {
  telegramId: string;
  username?: string;
  isOwner: boolean;
  workspace: Workspace;
}

export interface OutreachOptions {
  message: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'document' | 'audio';
  caption?: string;
  viewOnce?: boolean;
  link?: string;
}

export interface AsciiBlock {
  title: string;
  rows: [string, string][];     // [label, value] pairs
  footer?: string;
}

// Circuit breaker key pattern: `cb:{telegramId}:{sessionId}:{domain}`
// Workspace path pattern: `workspaces/{telegramId}/`
// Session path: `workspaces/{telegramId}/sessions/{sessionId}/auth/`
// Buckets: `workspaces/{telegramId}/buckets/{main|active|dead}.json`

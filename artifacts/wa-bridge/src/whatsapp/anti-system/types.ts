// ============================================================
// Anti System — Type Definitions
// ============================================================

export type AntiAction = 'kick' | 'warn' | 'delete';
export type AntiDemoteMode = 'dwp' | 'dnp' | 'kwp' | 'knp';

/** Base config shared by every anti module */
export interface AntiModuleConfig {
  enabled: boolean;
  action: AntiAction;
  warnThreshold: number;   // number of warns before kick (default 3)
  permitList: string[];    // normalized phone numbers exempt from this module
  customMessage?: string;  // override response template
}

/** AntiSpam extends with configurable window */
export interface AntiSpamConfig extends AntiModuleConfig {
  messageLimit: number;    // default 10
  windowSeconds: number;   // default 5
}

/** AntiWords extends with word list */
export interface AntiWordsConfig extends AntiModuleConfig {
  words: string[];         // lowercase blocked words/phrases
}

/** AntiDemote has a mode flag */
export interface AntiDemoteConfig extends AntiModuleConfig {
  mode: AntiDemoteMode;    // dwp | dnp | kwp | knp
}

/** Full anti config for a single group */
export interface GroupAntiConfig {
  groupJid: string;
  antilink?: AntiModuleConfig;
  antibot?: AntiModuleConfig;
  antispam?: AntiSpamConfig;
  antipic?: AntiModuleConfig;
  antivid?: AntiModuleConfig;
  antiaud?: AntiModuleConfig;
  antivn?: AntiModuleConfig;
  antitxt?: AntiModuleConfig;
  antiemoji?: AntiModuleConfig;
  antisticker?: AntiModuleConfig;
  antigroupcall?: AntiModuleConfig;
  antinsfw?: AntiModuleConfig;
  antigroupmention?: AntiModuleConfig;
  antigm?: AntiModuleConfig;
  antiwords?: AntiWordsConfig;
  antipoll?: AntiModuleConfig;
  antiforward?: AntiModuleConfig;
  antichannel?: AntiModuleConfig;
  antipromote?: AntiModuleConfig;
  antidemote?: AntiDemoteConfig;
  // Per-module custom response overrides
  messages?: Record<string, string>;
}

/** Per-session: all group anti configs */
export type SessionAntiConfig = Record<string, GroupAntiConfig>;

/** Violation context passed to action executor */
export interface ViolationContext {
  sessionId: string;
  telegramId: string;
  groupJid: string;
  senderJid: string;    // full JID with @s.whatsapp.net
  senderNumber: string; // normalized phone number
  moduleKey: keyof Omit<GroupAntiConfig, 'groupJid' | 'messages'>;
  moduleName: string;   // display name e.g. "AntiLink"
  moduleConfig: AntiModuleConfig;
  defaultMessage: string;
}

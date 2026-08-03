// ============================================================
// WA-Bridge — Standardized Response Builder
// Provides consistent SUCCESS, ERROR, WARNING, etc. templates.
// ============================================================

import { asciiBox } from './ascii-art.js';

export interface ResponseOptions {
  title: string;
  message: string;
  footer?: string;
  error?: string;
}

/**
 * Standardized Success Response
 */
export function successCard(title: string, message: string): string {
  return [
    `╭──〔 ✅ ${title.toUpperCase()} 〕`,
    `│`,
    `├ ${message}`,
    `╰──────────`
  ].join('\n');
}

/**
 * Standardized Error Response
 */
export function errorCard(title: string, message: string, error?: string): string {
  const lines = [
    `╭──〔 ❌ ${title.toUpperCase()} 〕`,
    `│`,
    `├ ${message}`
  ];
  if (error) {
    lines.push(`│`);
    lines.push(`├ Details: ${error}`);
  }
  lines.push(`╰──────────`);
  return lines.join('\n');
}

/**
 * Standardized Warning Response
 */
export function warningCard(title: string, message: string): string {
  return [
    `╭──〔 ⚠️ ${title.toUpperCase()} 〕`,
    `│`,
    `├ ${message}`,
    `╰──────────`
  ].join('\n');
}

/**
 * Standardized Processing Response
 */
export function processingCard(title: string, message: string): string {
  return [
    `╭──〔 ⚡ ${title.toUpperCase()} 〕`,
    `│`,
    `├ ${message}`,
    `╰──────────`
  ].join('\n');
}

/**
 * Standardized Info Response
 */
export function infoCard(title: string, message: string): string {
  return [
    `╭──〔 ℹ️ ${title.toUpperCase()} 〕`,
    `│`,
    `├ ${message}`,
    `╰──────────`
  ].join('\n');
}

/**
 * Standardized Moderation Response
 */
export function moderationCard(title: string, message: string): string {
  return [
    `╭──〔 ⚔️ ${title.toUpperCase()} 〕`,
    `│`,
    `├ ${message}`,
    `╰──────────`
  ].join('\n');
}

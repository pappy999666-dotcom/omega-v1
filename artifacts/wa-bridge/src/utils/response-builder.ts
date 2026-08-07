// ============================================================
// WA-Bridge — Standardized Response Builder
// Compatibility wrappers around the shared PAPPY renderer.
// ============================================================

import { asciiBox } from './ascii-art.js';

export interface ResponseOptions {
  title: string;
  message: string;
  footer?: string;
  error?: string;
}

function card(title: string, message: string, emoji: string, details?: string): string {
  const body = details ? `${message}\n${details}` : message;
  return asciiBox({ title, emoji, rows: [], footer: body });
}

export function successCard(title: string, message: string): string {
  return card(title, message, '✅');
}

export function errorCard(title: string, message: string, error?: string): string {
  return card(title, message, '❌', error ? `Details: ${error}` : undefined);
}

export function warningCard(title: string, message: string): string {
  return card(title, message, '⚠️');
}

export function processingCard(title: string, message: string): string {
  return card(title, message, '⚡');
}

export function infoCard(title: string, message: string): string {
  return card(title, message, 'ℹ️');
}

export function moderationCard(title: string, message: string): string {
  return card(title, message, '⚔️');
}

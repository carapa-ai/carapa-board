/**
 * Messaging provider registry — singleton pattern.
 *
 * The active provider is set by the WhatsApp (or future Telegram/Slack) module
 * during init. Core code uses getMessagingProvider() to access it.
 */

import type { MessagingProvider } from './types.js';

let provider: MessagingProvider | null = null;

export function setMessagingProvider(p: MessagingProvider | null): void {
  provider = p;
}

export function getMessagingProvider(): MessagingProvider | null {
  return provider;
}

import type { VoiceAdapter } from './types.js';

/**
 * One line per adapter. src/main.ts registers each with the app; nothing else imports this
 * file. conversationrelay lands with its feature stage; the text-chat adapter drives the
 * SessionFactory in-process for the status page and is not a registered route adapter.
 */
export const adapters: readonly VoiceAdapter[] = [];

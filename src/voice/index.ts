import { conversationRelay } from './conversationrelay/route.js';
import type { VoiceAdapter } from './types.js';

/**
 * One line per adapter. src/main.ts registers each with the app; nothing else imports this
 * file. A Media Streams adapter arrives as a sibling folder and one more line here, with the
 * speech-to-text and text-to-speech inside its own folder: the agent core never learns of it.
 *
 * The text-chat adapter is not listed: it drives the SessionFactory in-process for the status page
 * rather than registering a route.
 */
export const adapters: readonly VoiceAdapter[] = [conversationRelay];

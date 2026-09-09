/**
 * Log: pino JSON lines to stdout at LOG_LEVEL, secrets redacted by key and by value.
 * src/main.ts creates one AppLogger, registers config's secretValues and hands the pino Logger
 * to Fastify and to every module; a call logs through forCall(log, callSid).
 */
export { createLogger, forCall } from './logger.js';
export type { AppLogger, CreateLoggerOptions } from './logger.js';
export { events } from './events.js';
export type { EventName } from './events.js';
export { censorSecretKeys, createSecretScrubber, isSecretKey, REDACTED } from './redact.js';
export type { SecretScrubber } from './redact.js';
export type { Logger } from 'pino';

/**
 * The logger: pino, JSON lines to stdout at LOG_LEVEL, one object per line.
 *
 * Every line is { level, time, msg, event, ...fields }: level as a label (Railway colours and
 * filters by it), time in ISO 8601, no pid or hostname. Redaction is by key (censorSecretKeys over
 * the fields of every call and over serialized errors) and by value (the registered secret values
 * scrubbed from the finished line, so messages, child bindings and error stacks are covered too).
 * Fastify's per-request lines are switched off in src/app.ts so query strings never reach the
 * logs. Utterances and model text belong at debug only.
 */
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { LogLevel } from '../config/index.js';
import { censorSecretKeys, createSecretScrubber } from './redact.js';

export interface CreateLoggerOptions {
  level: LogLevel;
  /** Values to scrub from every line; registerSecrets() adds more later. */
  secrets?: readonly string[];
  /** Field names to censor besides the built-in list (config's secret variable names). */
  secretKeys?: readonly string[];
  /** Where lines go. Default: stdout, written synchronously so nothing is lost at exit. */
  destination?: DestinationStream;
}

export interface AppLogger {
  /**
   * The root logger. src/main.ts hands it to Fastify and to every module; forCall() derives the
   * per-call children. It is a plain pino Logger, the type the seam files declare.
   */
  log: Logger;
  /** Registers secret values to scrub from every later line (config's secretValues at boot). */
  registerSecrets(values: readonly string[]): void;
  /** The same value scrubbing for text that goes elsewhere, like a status-page detail. */
  scrub(text: string): string;
}

export function createLogger(options: CreateLoggerOptions): AppLogger {
  const scrubber = createSecretScrubber();
  if (options.secrets) scrubber.register(options.secrets);
  const extraKeys: ReadonlySet<string> = new Set(
    (options.secretKeys ?? []).map((key) => key.toLowerCase()),
  );
  const serializeError = pino.stdSerializers.err;

  const pinoOptions: LoggerOptions = {
    level: options.level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (fields) => censorSecretKeys(fields, extraKeys),
    },
    serializers: {
      err: (err: Error) => {
        // The standard shape (type, message, stack, own properties), then its keys censored.
        const serialized: unknown = serializeError(err);
        return typeof serialized === 'object' && serialized !== null
          ? censorSecretKeys(serialized as Record<string, unknown>, extraKeys)
          : serialized;
      },
    },
    hooks: { streamWrite: (line) => scrubber.scrubJson(line) },
  };
  const destination = options.destination ?? pino.destination({ dest: 1, sync: true });
  const log = pino(pinoOptions, destination);

  return {
    log,
    registerSecrets: (values) => scrubber.register(values),
    scrub: (text) => scrubber.scrub(text),
  };
}

/** A child logger that stamps callSid on every line of one call. */
export function forCall(log: Logger, callSid: string): Logger {
  return log.child({ callSid });
}

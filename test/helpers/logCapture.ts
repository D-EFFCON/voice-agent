/**
 * captureLogs: a real logger from src/log writing to memory, so a suite can assert on the exact
 * lines a module emits and prove nothing secret reached them. Pair it with leakedSecrets() for
 * the redaction check every later suite repeats:
 *
 *   const logs = captureLogs({ secrets: [KEY] });
 *   ... run the code under test with logs.log ...
 *   expect(leakedSecrets(logs.text(), [KEY])).toEqual([]);
 */
import type { Logger } from 'pino';
import type { LogLevel } from '../../src/config/index.js';
import { createLogger, type AppLogger } from '../../src/log/index.js';
import type { ServerLogLine } from './spawnServer.js';

export interface CaptureLogsOptions {
  /** Default debug, so a suite sees every line unless it asks for less. */
  level?: LogLevel;
  secrets?: readonly string[];
  secretKeys?: readonly string[];
}

export interface CapturedLogs {
  /** The handle: registerSecrets() and scrub(), as src/main.ts has it. */
  logger: AppLogger;
  /** The root pino Logger, as every module receives it. */
  log: Logger;
  /** Everything written so far, raw. */
  text(): string;
  /** Every line so far, parsed. Throws when a line is not JSON: that is a logger bug. */
  lines(): ServerLogLine[];
  /** The first line whose event matches. */
  find(event: string): ServerLogLine | undefined;
  /** Forgets what was written so far. */
  clear(): void;
}

export function captureLogs(options: CaptureLogsOptions = {}): CapturedLogs {
  const chunks: string[] = [];
  const logger = createLogger({
    level: options.level ?? 'debug',
    secrets: options.secrets,
    secretKeys: options.secretKeys,
    destination: {
      write: (chunk: string) => {
        chunks.push(chunk);
      },
    },
  });
  const text = (): string => chunks.join('');
  const lines = (): ServerLogLine[] =>
    text()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as ServerLogLine;
        } catch {
          throw new Error(`Log line is not JSON: ${line}`);
        }
      });
  return {
    logger,
    log: logger.log,
    text,
    lines,
    find: (event) => lines().find((line) => line.event === event),
    clear: () => {
      chunks.length = 0;
    },
  };
}

/** The given values that appear in the text, for `expect(leakedSecrets(text, secrets)).toEqual([])`. */
export function leakedSecrets(text: string, secrets: readonly string[]): string[] {
  return secrets.filter((secret) => secret.length > 0 && text.includes(secret));
}

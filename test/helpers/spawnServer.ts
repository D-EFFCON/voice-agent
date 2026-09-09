/**
 * spawnBuiltServer: boots `node dist/main.js` on a free port with a clean environment and
 * parses its stdout as JSON log lines.
 *
 * Needs `pnpm build` first; CI builds before it tests. Only the variables node itself needs
 * are copied from the parent process, so a test controls the server's whole configuration.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

export interface ServerLogLine extends Record<string, unknown> {
  event?: string;
  msg?: string;
  level?: string;
}

export interface SpawnedServer {
  port: number;
  baseUrl: string;
  child: ChildProcess;
  /** Parsed JSON lines from stdout, in order. */
  logs: ServerLogLine[];
  /** Every stdout line, parsed or not. */
  stdout: string[];
  stderr: string[];
  /** Resolves with the first log line whose event matches, now or later. */
  waitForEvent(event: string, timeoutMs?: number): Promise<ServerLogLine>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM, then SIGKILL after 8 s. Resolves once the process is gone. */
  stop(): Promise<void>;
}

const repoRoot = resolve(import.meta.dirname, '..', '..');
export const builtEntry = resolve(repoRoot, 'dist', 'main.js');

const passthroughKeys = [
  'PATH',
  'Path',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'COMSPEC',
  'ComSpec',
];

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

function parseJsonLine(line: string): ServerLogLine | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as ServerLogLine;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function spawnBuiltServer(
  opts: { env?: Record<string, string>; readyEvent?: string; readyTimeoutMs?: number } = {},
): Promise<SpawnedServer> {
  if (!existsSync(builtEntry)) {
    throw new Error(
      'dist/main.js is missing. Run pnpm build first; this suite boots the built server.',
    );
  }
  const port = await freePort();
  const env: Record<string, string> = {};
  for (const key of passthroughKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, { PORT: String(port) }, opts.env ?? {});

  const child = spawn(process.execPath, [builtEntry], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (!child.stdout || !child.stderr)
    throw new Error('spawn did not open stdout and stderr pipes.');

  const logs: ServerLogLine[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const listeners = new Set<(line: ServerLogLine) => void>();

  createInterface({ input: child.stdout }).on('line', (line) => {
    stdout.push(line);
    const parsed = parseJsonLine(line);
    if (!parsed) return;
    logs.push(parsed);
    for (const listener of listeners) listener(parsed);
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderr.push(line);
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
  });

  const tail = (): string => stderr.slice(-5).join(' | ') || '(no stderr)';

  const waitForEvent = (event: string, timeoutMs = 10_000): Promise<ServerLogLine> =>
    new Promise((resolveLine, reject) => {
      const found = logs.find((line) => line.event === event);
      if (found) {
        resolveLine(found);
        return;
      }
      const timer = setTimeout(() => {
        listeners.delete(onLine);
        reject(new Error(`No log event ${event} within ${timeoutMs} ms. stderr: ${tail()}`));
      }, timeoutMs);
      const onLine = (line: ServerLogLine): void => {
        if (line.event !== event) return;
        clearTimeout(timer);
        listeners.delete(onLine);
        resolveLine(line);
      };
      listeners.add(onLine);
      void exited.then(({ code, signal }) => {
        clearTimeout(timer);
        listeners.delete(onLine);
        reject(
          new Error(
            `Server exited (code ${String(code)}, signal ${String(signal)}) before ${event}. stderr: ${tail()}`,
          ),
        );
      });
    });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    await exited;
    clearTimeout(timer);
  };

  await waitForEvent(opts.readyEvent ?? 'server.listening', opts.readyTimeoutMs ?? 10_000);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    logs,
    stdout,
    stderr,
    waitForEvent,
    exited,
    stop,
  };
}

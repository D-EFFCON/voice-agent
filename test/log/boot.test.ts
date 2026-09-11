/**
 * The built server logs through src/log (run `pnpm build` first): level labels and ISO times on
 * stdout with nothing else on it, LOG_LEVEL honoured, an invalid LOG_LEVEL falling back to info
 * with a warning, and server.draining on SIGTERM.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnBuiltServer, type SpawnedServer } from '../helpers/index.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The server logs config problems before it listens, so a suite that waits on one polls for the port. */
async function waitForHealth(baseUrl: string, timeoutMs = 10_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetch(`${baseUrl}/health`);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(100);
    }
  }
}

describe('built server logging', () => {
  let server: SpawnedServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('writes level labels and ISO times, no pid or hostname, and nothing but JSON on stdout', async () => {
    server = await spawnBuiltServer();
    const listening = await server.waitForEvent('server.listening');
    expect(listening.level).toBe('info');
    expect(typeof listening.time).toBe('string');
    expect(new Date(listening.time as string).toISOString()).toBe(listening.time);
    expect(listening).not.toHaveProperty('pid');
    expect(listening).not.toHaveProperty('hostname');

    const blocking = server.logs.find(
      (l) => l.event === 'config.problem' && l.severity === 'blocking',
    );
    const warning = server.logs.find(
      (l) => l.event === 'config.problem' && l.severity === 'warning',
    );
    expect(blocking?.level).toBe('error');
    expect(warning?.level).toBe('warn');

    expect(server.stdout.filter((line) => line.trim() !== '' && !line.startsWith('{'))).toEqual([]);
    expect(server.logs.length).toBe(server.stdout.filter((line) => line.trim() !== '').length);
  }, 20_000);

  it('honours LOG_LEVEL=warn: problems are logged, server.listening is not', async () => {
    server = await spawnBuiltServer({ env: { LOG_LEVEL: 'warn' }, readyEvent: 'config.problem' });
    expect((await waitForHealth(server.baseUrl)).status).toBe(200);
    await sleep(200);
    expect(server.logs.some((l) => l.event === 'config.problem')).toBe(true);
    expect(server.logs.filter((l) => l.level === 'info')).toEqual([]);
    expect(server.logs.find((l) => l.event === 'server.listening')).toBeUndefined();
  }, 20_000);

  it('falls back to info on an invalid LOG_LEVEL and logs the warning that says so', async () => {
    server = await spawnBuiltServer({ env: { LOG_LEVEL: 'loud' } });
    await server.waitForEvent('server.listening');
    const warning = server.logs.find(
      (l) => l.event === 'config.problem' && l.variable === 'LOG_LEVEL',
    );
    expect(warning?.severity).toBe('warning');
    expect(warning?.level).toBe('warn');
  }, 20_000);

  // Windows has no SIGTERM: child.kill() there ends the process without running the handler.
  it.skipIf(process.platform === 'win32')(
    'logs server.draining when asked to stop',
    async () => {
      server = await spawnBuiltServer();
      await server.stop();
      const deadline = Date.now() + 5_000;
      while (!server.logs.some((l) => l.event === 'server.draining') && Date.now() < deadline) {
        await sleep(50);
      }
      expect(server.logs.find((l) => l.event === 'server.draining')).toMatchObject({
        level: 'info',
        signal: 'SIGTERM',
        active_calls: 0,
        deadline_ms: 8000,
      });
      expect(server.logs.find((l) => l.event === 'server.stopped')).toMatchObject({
        level: 'info',
        signal: 'SIGTERM',
        sessions: 'done',
        close: 'done',
      });
    },
    20_000,
  );
});

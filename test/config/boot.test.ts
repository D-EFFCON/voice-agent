/**
 * Misconfig boot matrix against the built server (run `pnpm build` first): the process boots
 * on an empty environment and on a complete one, GET /health carries the config verdict, the
 * config.problem log lines carry names only, and no secret value reaches stdout or a page.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigProblem } from '../../src/config/index.js';
import { spawnBuiltServer, visibleText, type SpawnedServer } from '../helpers/index.js';

interface HealthBody {
  ready: boolean;
  commit: string;
  active_calls: number;
  problems: ConfigProblem[];
}

const VALID: Record<string, string> = {
  PUBLIC_HOST: 'boot-valid.example.com',
  WS_SECRET: 'bootWsSecretValue0123456789abcdef',
  TWILIO_AUTH_TOKEN: 'bootTwilioAuthTokenValue0123456789',
  STATUS_TOKEN: 'bootStatusTokenValue0123',
  OPENAI_API_KEY: 'sk-bootOpenaiKeyValue0123456789',
  AUTOMATION_PROVIDER: 'make',
  AUTOMATION_WEBHOOK_URL: 'https://hook.example.com/boot',
  AUTOMATION_WEBHOOK_KEY: 'bootWebhookKeyValue0123',
  RAILWAY_GIT_COMMIT_SHA: 'deadbeefcafe',
};

const SECRETS = [
  VALID.WS_SECRET,
  VALID.TWILIO_AUTH_TOKEN,
  VALID.STATUS_TOKEN,
  VALID.OPENAI_API_KEY,
  VALID.AUTOMATION_WEBHOOK_KEY,
].filter((v): v is string => v !== undefined);

describe('built server boot with config', () => {
  let server: SpawnedServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('boots on an empty environment, not ready, and names every blocking variable', async () => {
    server = await spawnBuiltServer();
    const listening = await server.waitForEvent('server.listening');
    expect(listening.host_source).toBeNull();
    expect(listening.ready).toBe(false);
    expect(listening.commit).toBe('local');

    const res = await fetch(`${server.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.ready).toBe(false);
    expect(body.commit).toBe('local');
    expect(body.active_calls).toBe(0);
    expect(body.problems.filter((p) => p.severity === 'blocking').map((p) => p.variable)).toEqual([
      'PUBLIC_HOST',
      'WS_SECRET',
      'TWILIO_AUTH_TOKEN',
      'OPENAI_API_KEY',
    ]);
    expect(body.problems.filter((p) => p.severity === 'warning').map((p) => p.variable)).toEqual([
      'STATUS_TOKEN',
      'AUTOMATION_PROVIDER',
    ]);

    const logged = server.logs.filter((line) => line.event === 'config.problem');
    expect(logged.map((line) => line.variable)).toEqual(body.problems.map((p) => p.variable));
    expect(logged.map((line) => line.severity)).toEqual(body.problems.map((p) => p.severity));

    const page = await (await fetch(`${server.baseUrl}/`)).text();
    expect(page).toContain('<h2>Not ready</h2>');
    expect(visibleText(page)).toContain('WS_SECRET: is not set. Set it to a random string');
  }, 20_000);

  it('boots ready on a complete environment and never prints a secret', async () => {
    server = await spawnBuiltServer({ env: VALID });
    const listening = await server.waitForEvent('server.listening');
    expect(listening.host_source).toBe('PUBLIC_HOST');
    expect(listening.ready).toBe(true);
    expect(listening.commit).toBe('deadbeefcafe');

    const body = (await (await fetch(`${server.baseUrl}/health`)).json()) as HealthBody;
    expect(body.ready).toBe(true);
    expect(body.problems).toEqual([]);
    expect(body.commit).toBe('deadbeefcafe');
    expect(server.logs.filter((line) => line.event === 'config.problem')).toEqual([]);

    const page = await (await fetch(`${server.baseUrl}/`)).text();
    expect(page).toContain('<h2>Ready</h2>');

    const output = [...server.stdout, ...server.stderr, page, JSON.stringify(body)].join('\n');
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  }, 20_000);
});

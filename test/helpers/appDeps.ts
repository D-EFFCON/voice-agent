/**
 * testAppDeps: everything buildApp() needs, with fakes a suite can override one at a time.
 * The gate is the real one over fixed test secrets, the unlock the real exchange over a test
 * STATUS_TOKEN, the logger a captureLogs() sink, the sessions a stand-in that opens nothing.
 *
 *   const deps = testAppDeps({ ready: true, problems: [] });
 *   const { app } = await buildApp(deps);
 *   ... deps.logs.text(), deps.recent.list(), deps.sessions.closeAll.mock ...
 */
import { vi, type Mock } from 'vitest';
import type { AppDeps, Sessions } from '../../src/app.js';
import { relayPath, urlVariantsFor } from '../../src/config/index.js';
import {
  createStatusUnlock,
  createUpgradeGate,
  type UpgradeGate,
  type UpgradeGateOptions,
} from '../../src/security/index.js';
import { createRecentProblems } from '../../src/status/index.js';
import { captureLogs, type CapturedLogs } from './logCapture.js';

export const TEST_WS_SECRET = 'wsSecretForTests0123456789abcdef';
export const TEST_AUTH_TOKEN = 'twilioAuthTokenForTests0123456789';
export const TEST_STATUS_TOKEN = 'statusTokenForTests0123456789';
export const TEST_HOST = 'voice.example.test';
/** Every secret the fixtures hold, for leakedSecrets(). */
export const TEST_SECRETS: readonly string[] = [TEST_WS_SECRET, TEST_AUTH_TOKEN, TEST_STATUS_TOKEN];
/** The URLs the test gate signs, in the documented order; [0] is the wss URL. */
export const TEST_SIGNATURE_URLS: readonly string[] = urlVariantsFor(
  TEST_HOST,
  relayPath(TEST_WS_SECRET),
);

/** The real gate over the test secrets. */
export function testGate(over: Partial<UpgradeGateOptions> = {}): UpgradeGate {
  return createUpgradeGate({
    wsSecret: TEST_WS_SECRET,
    ready: true,
    authToken: TEST_AUTH_TOKEN,
    signatureMode: 'enforce',
    signatureUrlVariants: TEST_SIGNATURE_URLS,
    maxConcurrentCalls: 10,
    ...over,
  });
}

export interface FakeSessions extends Sessions {
  open: Mock<Sessions['open']>;
  closeAll: Mock<Sessions['closeAll']>;
}

/** Opens nothing (not_ready), reports the given active calls, ends nothing. */
export function fakeSessions(activeCalls = 0): FakeSessions {
  return {
    open: vi.fn<Sessions['open']>(() => ({ ok: false, reason: 'not_ready' })),
    activeCalls: () => activeCalls,
    closeAll: vi.fn<Sessions['closeAll']>(() => Promise.resolve()),
  };
}

export interface TestAppDeps extends AppDeps {
  logs: CapturedLogs;
  sessions: FakeSessions;
}

export function testAppDeps(over: Partial<AppDeps> = {}): TestAppDeps {
  const logs = captureLogs({ secrets: TEST_SECRETS });
  const sessions = fakeSessions();
  return {
    ready: false,
    problems: [],
    commit: 'test',
    log: logs.log,
    gate: testGate({ ready: false }),
    unlock: createStatusUnlock({ statusToken: TEST_STATUS_TOKEN }),
    recent: createRecentProblems(),
    sessions,
    adapters: [],
    ...over,
    logs,
  } as TestAppDeps;
}

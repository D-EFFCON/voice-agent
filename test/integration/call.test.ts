/**
 * A whole call, against the real built server over a real WebSocket.
 *
 * Everything else in the suite tests a piece. This one is the proof the pieces fit: `node
 * dist/main.js` boots with a deployer-shaped environment, Twilio's own signature gets an upgrade
 * through the gate, and a caller speaks, is answered, interrupts, asks for a person, and is handed
 * over with the payload a Studio flow reads.
 *
 * It runs on LLM_PROVIDER=fake, so it needs no key and makes no network call. That is the same
 * provider the owner can point a first deployment at before spending anything.
 *
 * Needs `pnpm build` first; CI builds before it tests.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  spawnBuiltServer,
  type ServerLogLine,
  type SpawnedServer,
} from '../helpers/spawnServer.js';

const WS_SECRET = 'wsSecretForTheIntegrationRun0123456789';
const AUTH_TOKEN = 'twilioAuthTokenForTheIntegrationRun012345';
const STATUS_TOKEN = 'statusTokenForTheIntegrationRun0123';
const PUBLIC_HOST = 'voice.example.test';
const RELAY_PATH = `/twilio/conversationrelay/${WS_SECRET}`;

/** What Twilio signs for a ConversationRelay upgrade: the wss URL, with no parameters. */
const signatureFor = (url: string): string =>
  createHmac('sha1', AUTH_TOKEN).update(Buffer.from(url, 'utf8')).digest('base64');

interface Frame {
  type: string;
  token?: string;
  last?: boolean;
  interruptible?: boolean;
  handoffData?: string;
}

/** A caller on the far end of the socket. */
class Caller {
  readonly frames: Frame[] = [];
  private readonly socket: WebSocket;
  private readonly waiters: (() => void)[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as Frame;
      this.frames.push(frame);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  static connect(port: number, over: { signature?: string; path?: string } = {}): Promise<Caller> {
    const path = over.path ?? RELAY_PATH;
    const signature = over.signature ?? signatureFor(`wss://${PUBLIC_HOST}${path}`);
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${path}`, {
      headers: { 'x-twilio-signature': signature },
    });
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(new Caller(socket)));
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) => {
        reject(new Error(`upgrade refused with ${String(res.statusCode)}`));
      });
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  setup(callSid = 'CAintegration1'): void {
    this.send({
      type: 'setup',
      sessionId: 'VXintegration1',
      callSid,
      from: '+15550001111',
      to: '+15550002222',
      direction: 'inbound',
      callType: 'PSTN',
      customParameters: { queue: 'support' },
    });
  }

  says(text: string): void {
    this.send({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true });
  }

  /** Waits until `check` is satisfied by the frames received so far. */
  async until(check: (frames: Frame[]) => boolean, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check(this.frames)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out; frames so far: ${JSON.stringify(this.frames)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Everything spoken, joined, which is what the caller would hear. */
  spoken(): string {
    return this.frames
      .filter((f) => f.type === 'text')
      .map((f) => f.token ?? '')
      .join('');
  }

  endFrame(): Frame | undefined {
    return this.frames.find((f) => f.type === 'end');
  }

  hangUp(): void {
    this.socket.close();
  }

  close(): void {
    this.socket.terminate();
  }
}

let server: SpawnedServer;

beforeAll(async () => {
  server = await spawnBuiltServer({
    env: {
      PUBLIC_HOST,
      WS_SECRET,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      STATUS_TOKEN,
      LLM_PROVIDER: 'fake',
      AUTOMATION_PROVIDER: 'none',
      LOG_LEVEL: 'debug',
      IDLE_TIMEOUT_SECONDS: '30',
    },
    readyEvent: 'server.listening',
  });
}, 30_000);

afterAll(async () => {
  await server?.stop();
});

/**
 * Waits for a log line about one particular call. Waiting on the event alone would be satisfied by
 * an earlier test s line, since the server outlives every test in this file.
 */
async function waitForLine(
  event: string,
  callSid: string,
  timeoutMs = 8_000,
): Promise<ServerLogLine> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = server.logs.find((line) => line.event === event && line.callSid === callSid);
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error(`no ${event} for ${callSid} within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('a call, end to end', () => {
  it('boots ready, with the provider it was configured for', () => {
    const listening = server.logs.find((line) => line.event === 'server.listening');
    expect(listening).toMatchObject({ ready: true, provider: 'fake' });
  });

  it('answers the caller, streaming the words rather than sending them in one lump', async () => {
    const caller = await Caller.connect(server.port);
    caller.setup('CAtalk');
    caller.says('hello there');

    await caller.until((frames) => frames.some((f) => f.type === 'text' && f.last === true));

    const texts = caller.frames.filter((f) => f.type === 'text');
    expect(texts.length).toBeGreaterThan(2);
    expect(texts.filter((f) => f.last === true)).toHaveLength(1);
    expect(texts.at(-1)?.last).toBe(true);
    expect(caller.spoken()).toContain('how can I help');
    // Barge-in has to be possible or an interrupt could never arrive.
    expect(texts.some((f) => f.interruptible === true)).toBe(true);

    caller.close();
  });

  it('hands the caller to a person, with the payload Studio reads', async () => {
    const caller = await Caller.connect(server.port);
    caller.setup('CAhandoff');
    caller.says('I would like to talk to a human please');

    await caller.until((frames) => frames.some((f) => f.type === 'end'));

    const end = caller.endFrame();
    expect(end?.handoffData).toBeDefined();
    const data = JSON.parse(end?.handoffData ?? '{}') as Record<string, unknown>;

    // The substring a Studio Split widget matches on, and it is the first key in the raw string.
    expect(end?.handoffData).toContain('live-agent-handoff');
    expect(Object.keys(data)[0]).toBe('reasonCode');
    expect(data).toMatchObject({
      reasonCode: 'live-agent-handoff',
      v: 1,
      reason: 'caller_request',
      callSid: 'CAhandoff',
      from: '+15550001111',
      to: '+15550002222',
      // AUTOMATION_PROVIDER=none, so nobody was notified and the field says so honestly.
      webhook: 'skipped',
    });
    expect(caller.spoken()).toContain('put you through');

    caller.close();
  });

  it('stops talking when the caller interrupts', async () => {
    const caller = await Caller.connect(server.port);
    caller.setup('CAinterrupt');
    caller.says('tell me about my order');

    await caller.until((frames) => frames.filter((f) => f.type === 'text').length >= 2);
    const spokenAtInterrupt = caller.frames.filter((f) => f.type === 'text').length;
    caller.send({
      type: 'interrupt',
      utteranceUntilInterrupt: caller.spoken(),
      durationUntilInterruptMs: 400,
    });

    await new Promise((resolve) => setTimeout(resolve, 600));

    const after = caller.frames.filter((f) => f.type === 'text').length;
    // At most the chunk already in flight when the interrupt landed.
    expect(after).toBeLessThanOrEqual(spokenAtInterrupt + 1);

    caller.close();
  });

  it('records a hangup and forgets the call', async () => {
    const caller = await Caller.connect(server.port);
    caller.setup('CAhangup');
    caller.says('hello');
    await caller.until((frames) => frames.some((f) => f.type === 'text'));

    caller.hangUp();

    expect(await waitForLine('call.ended', 'CAhangup')).toMatchObject({
      outcome: 'caller_hangup',
    });
  });

  it('logs one turn.timing per turn, with the fields the README filter needs', async () => {
    const caller = await Caller.connect(server.port);
    caller.setup('CAtiming');
    caller.says('hello');
    await caller.until((frames) => frames.some((f) => f.type === 'text' && f.last === true));

    const timing = await waitForLine('turn.timing', 'CAtiming');
    expect(typeof timing.ms_prompt_to_first_text_out).toBe('number');
    // Named like a credential, but a measurement: redaction must not blank it.
    expect(typeof timing.ms_prompt_to_llm_first_token).toBe('number');
    expect(timing.tokens_out).toBeGreaterThan(0);

    caller.close();
  });

  it('ignores a partial transcript and a frame type it does not know', async () => {
    const caller = await Caller.connect(server.port);
    caller.setup('CAnoise');
    // Neither of these should start a turn or end the call.
    caller.send({ type: 'prompt', voicePrompt: 'half a sen', lang: 'en-US', last: false });
    caller.send({ type: 'somethingNew', payload: { anything: true } });
    caller.send({ type: 'dtmf', digit: '5' });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(caller.frames).toEqual([]);

    // And the call still works afterwards.
    caller.says('hello');
    await caller.until((frames) => frames.some((f) => f.type === 'text'));

    caller.close();
  });
});

describe('the gate every upgrade passes', () => {
  it('refuses a wrong path secret with 404 and no body', async () => {
    const path = '/twilio/conversationrelay/definitely-not-the-secret';
    await expect(
      Caller.connect(server.port, { path, signature: signatureFor(`wss://${PUBLIC_HOST}${path}`) }),
    ).rejects.toThrow('404');
  });

  it('refuses a missing or wrong signature with 403', async () => {
    await expect(Caller.connect(server.port, { signature: 'not-a-signature' })).rejects.toThrow(
      '403',
    );
  });

  it('names the URL it signed, so a host mistake is diagnosable', async () => {
    await Caller.connect(server.port, { signature: 'wrong' }).catch(() => undefined);

    const rejected = server.logs.find(
      (line) => line.event === 'ws.rejected' && line.reason === 'signature',
    );
    // The host is what a deployer gets wrong, and it is named. The path secret inside the URL is
    // scrubbed by the logger, which is why this asserts the shape rather than the whole string.
    expect(rejected?.signedUrl).toContain(`wss://${PUBLIC_HOST}/twilio/conversationrelay/`);
    expect(rejected?.signedUrl).not.toContain(WS_SECRET);
  });

  it('never writes a secret into the logs', () => {
    const text = server.stdout.join('\n');
    for (const secret of [WS_SECRET, AUTH_TOKEN, STATUS_TOKEN]) {
      expect(text).not.toContain(secret);
    }
  });
});

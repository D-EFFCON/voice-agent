/**
 * MockWebhookServer: a local HTTP endpoint standing in for Make, Zapier or n8n.
 *
 * Records every request (headers and parsed JSON) and answers with a configurable reply:
 * status, JSON or text body, headers, a delay, or hang (never answer) for timeout tests.
 *
 * The real AutomationClient is https-only and refuses loopback hosts, so tests of the client
 * inject fetch or use its test-only insecure option; this server speaks plain HTTP on
 * 127.0.0.1. That decision belongs to tools-and-automation-webhook.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AutomationPresetId } from '../../src/tools/types.js';

export interface MockWebhookRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  raw: string;
  /** The body parsed as JSON, or undefined when it is not JSON. */
  json: unknown;
  at: number;
}

export interface MockWebhookReply {
  status?: number;
  /** An object is sent as JSON; a string as text/plain; undefined as an empty body. */
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Never answer; the connection stays open until close(). */
  hang?: boolean;
}

export type MockWebhookReplier = MockWebhookReply | ((req: MockWebhookRequest) => MockWebhookReply);

function defaultReply(preset: AutomationPresetId): MockWebhookReply {
  if (preset === 'zapier') {
    return {
      status: 200,
      body: { status: 'success', attempt: 'mock', id: 'mock', request_id: 'mock' },
    };
  }
  return { status: 200, body: { ok: true } };
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class MockWebhookServer {
  readonly requests: MockWebhookRequest[] = [];
  private replier: MockWebhookReplier;
  private readonly waiters: ((req: MockWebhookRequest) => void)[] = [];
  /** How many of `requests` waitForRequest() has already handed out. */
  private consumed = 0;

  private constructor(
    private readonly server: Server,
    readonly preset: AutomationPresetId,
    readonly url: string,
    replier: MockWebhookReplier,
  ) {
    this.replier = replier;
  }

  static async start(
    opts: { preset?: AutomationPresetId; reply?: MockWebhookReplier } = {},
  ): Promise<MockWebhookServer> {
    const preset = opts.preset ?? 'make';
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const mock = new MockWebhookServer(
      server,
      preset,
      `http://127.0.0.1:${port}/hook`,
      opts.reply ?? defaultReply(preset),
    );
    server.on('request', (req, res) => {
      void mock.handle(req, res);
    });
    return mock;
  }

  /** Changes how later requests are answered. */
  reply(replier: MockWebhookReplier): void {
    this.replier = replier;
  }

  /** Resolves with the earliest request not yet handed out, waiting for one if needed. */
  waitForRequest(timeoutMs = 2000): Promise<MockWebhookRequest> {
    const ready = this.requests[this.consumed];
    if (ready) {
      this.consumed += 1;
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(onRequest);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`No webhook request within ${timeoutMs} ms.`));
      }, timeoutMs);
      const onRequest = (req: MockWebhookRequest): void => {
        clearTimeout(timer);
        this.consumed += 1;
        resolve(req);
      };
      this.waiters.push(onRequest);
    });
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const record: MockWebhookRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: flattenHeaders(req),
      raw,
      json,
      at: Date.now(),
    };
    this.requests.push(record);
    const waiter = this.waiters.shift();
    if (waiter) waiter(record);

    const reply = typeof this.replier === 'function' ? this.replier(record) : this.replier;
    if (reply.hang) return;
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));

    const headers: Record<string, string> = { ...reply.headers };
    let body = '';
    if (typeof reply.body === 'string') {
      body = reply.body;
      headers['content-type'] ??= 'text/plain; charset=utf-8';
    } else if (reply.body !== undefined) {
      body = JSON.stringify(reply.body);
      headers['content-type'] ??= 'application/json; charset=utf-8';
    }
    res.writeHead(reply.status ?? 200, headers);
    res.end(body);
  }
}

/**
 * attemptUpgrade: one raw WebSocket handshake against a listening server, with any headers a
 * test wants (x-twilio-signature, x-forwarded-for). Resolves with the HTTP status the server
 * answered: 101 with the open socket, or the refusal (403, 404, 429, 503) with its body.
 * Plain node:http, so no client library and no hidden retries.
 */
import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';

export interface UpgradeAttempt {
  status: number;
  headers: IncomingHttpHeaders;
  /** The response body for a refusal; empty for 101. */
  body: string;
  /** The raw socket, open, when the server answered 101. */
  socket?: Duplex;
  /** Drops the connection either way. */
  close(): void;
}

export function attemptUpgrade(o: {
  port: number;
  path: string;
  host?: string;
  headers?: Record<string, string>;
}): Promise<UpgradeAttempt> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: o.host ?? '127.0.0.1',
      port: o.port,
      path: o.path,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...o.headers,
      },
    });
    req.once('upgrade', (res, socket) => {
      resolve({
        status: res.statusCode ?? 101,
        headers: res.headers,
        body: '',
        socket,
        close: () => socket.destroy(),
      });
    });
    req.once('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.once('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          close: () => res.destroy(),
        });
      });
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
}

/**
 * The WebSocket route Twilio connects to, and the gate every upgrade passes first.
 *
 * The gate order is fixed and is the same one the app shell's placeholder uses, so a deployment
 * answers identically whether or not this adapter is present: a wrong path secret gets 404 with no
 * body, a blocking config problem gets 503, a bad Twilio signature gets 403, and a full deployment
 * gets 503. Every refusal is logged with the exact URL the server signed, because a signature that
 * does not match is the one failure a deployer cannot guess at, and it names PUBLIC_HOST when the
 * host is what went wrong.
 *
 * A 503 here lands on the Studio widget's Failed transition, which the example flow routes to a
 * person. That is deliberate: a caller should reach somebody even when this server will not talk.
 */
import type { FastifyInstance } from 'fastify';
import { RELAY_PATH_PREFIX } from '../../config/index.js';
import { events } from '../../log/index.js';
import { clientIp, readSignatureHeader, wsUpgradeRouteConfig } from '../../security/index.js';
import type { VoiceAdapter, VoiceAdapterDeps } from '../types.js';
import { attachRelayLink } from './link.js';

/** `/twilio/conversationrelay/:secret` */
export const RELAY_ROUTE = `${RELAY_PATH_PREFIX}:secret`;

export const conversationRelay: VoiceAdapter = {
  id: 'conversationrelay',
  kind: 'text',

  register(app: FastifyInstance, deps: VoiceAdapterDeps): void {
    app.get<{ Params: { secret: string } }>(
      RELAY_ROUTE,
      {
        websocket: true,
        // Its own generous bucket: Twilio's upgrades arrive from a few shared addresses, so the
        // ordinary per-address HTTP limit would refuse real calls during a burst.
        config: wsUpgradeRouteConfig,
        preValidation: async (request, reply) => {
          const decision = deps.gate.check({
            secret: request.params.secret,
            signature: readSignatureHeader(request.headers),
            /*
             * An adapter is handed a SessionFactory, not the registry, so it cannot count live
             * calls. src/main.ts wraps the gate with the registry's own count, which is the
             * authority; this value is a placeholder that wrapper replaces. Even without it the
             * capacity rule still holds, because opening the session refuses past the limit and the
             * link closes the socket, but the wrapper is what turns that into a 503 before the
             * upgrade, which is what puts the caller on the flow's Failed transition and so with a
             * person.
             */
            activeCalls: 0,
          });
          const ip = clientIp(request);

          if (decision.ok) {
            if (decision.warning !== undefined) {
              // TWILIO_SIGNATURE_MODE=warn let this through. Visible on the page, never silent.
              deps.log.warn(
                {
                  event: events.wsRejected,
                  reason: 'signature',
                  signedUrl: decision.signedUrl,
                  ip,
                },
                decision.warning,
              );
              deps.recent.record({
                kind: 'ws_rejected',
                detail: `signature: ${decision.warning}`,
                ...(decision.signedUrl === null ? {} : { signedUrl: decision.signedUrl }),
              });
            }
            return;
          }

          deps.log.warn(
            {
              event: events.wsRejected,
              reason: decision.reason,
              signedUrl: decision.signedUrl,
              variantsTried: decision.variantsTried,
              ip,
            },
            decision.message,
          );
          deps.recent.record({
            kind: 'ws_rejected',
            detail: `${decision.reason}: ${decision.message}`,
            ...(decision.signedUrl === undefined ? {} : { signedUrl: decision.signedUrl }),
          });

          // 404 carries no body at all: an empty answer tells a scanner nothing about the path.
          if (decision.status === 404) await reply.code(404).send();
          else await reply.code(decision.status).send({ error: decision.message });
          return reply;
        },
      },
      (socket, request) => {
        attachRelayLink({
          socket,
          sessions: deps.sessions,
          recent: deps.recent,
          log: deps.log.child({ ip: clientIp(request) }),
        });
      },
    );
  },
};

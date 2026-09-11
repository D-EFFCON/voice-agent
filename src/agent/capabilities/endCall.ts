/**
 * end_call: the agent's own way to hang up when the conversation is genuinely finished.
 *
 * It is a capability rather than a registry tool, which is a deliberate distinction. The registry
 * holds tools that reach the deployer's own systems and that a contributor can add; this one is part
 * of how a call ends, so it lives with the end policy and is never listed in src/tools/registry.ts.
 * The blueprint's "v1 ships exactly one tool" is about that registry.
 *
 * It ships enabled (AGENT_END_CALL, default true) because without it the agent can never say
 * goodbye: every call would run to the idle timeout or the caller would have to hang up. The risk
 * lens at the blueprint gate argued the opposite, that a model ending a call early is invisible, so
 * `call.ended` records the turn count on every completed call and the deployer can set
 * AGENT_END_CALL=false.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../../tools/types.js';

const endCallInput = z.object({
  reason: z
    .string()
    .max(200)
    .optional()
    .describe('Why the call is finished, in a few words. For the log, not for the caller.'),
});

export type EndCallInput = z.infer<typeof endCallInput>;

export const END_CALL_TOOL_NAME = 'end_call';

/**
 * The model must speak its goodbye before calling this, in the same turn: the description says so,
 * and the turn loop sends whatever it said with last:true before the line closes.
 */
export function createEndCallCapability(): ToolDefinition<EndCallInput> {
  return {
    name: END_CALL_TOOL_NAME,
    description:
      'End the call. Call this only when the caller has said goodbye or confirmed they need nothing else. Say your own goodbye to the caller first, in the same reply.',
    inputSchema: endCallInput,
    terminal: true,

    run(input: EndCallInput): Promise<ToolResult> {
      return Promise.resolve({
        modelText: 'The call is ending.',
        end: {
          reasonCode: 'end-call',
          reason: 'agent_end_call',
          summary: input.reason ?? 'The conversation finished.',
        },
      });
    },
  };
}

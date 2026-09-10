import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTools, presets, toolNames } from '../../src/tools/registry.js';
import type { AutomationClient, ToolDefinition, ToolResult } from '../../src/tools/types.js';

/** The tools need an automation client; these tests only care that the array is well formed. */
const silentAutomation: AutomationClient = {
  post: () => Promise.resolve({ status: 'skipped', fields: {}, ms: 0 }),
};
const tools = createTools({ automation: silentAutomation });

describe('tools registry', () => {
  it('lists the four presets in order with their metadata', () => {
    expect(presets.map((p) => p.id)).toEqual(['none', 'make', 'zapier', 'n8n']);
    expect(presets.map((p) => [p.id, p.defaultKeyHeader, p.responseMode])).toEqual([
      ['none', null, 'none'],
      ['make', 'x-make-apikey', 'merge-json'],
      ['zapier', null, 'ack-only'],
      ['n8n', 'x-api-key', 'merge-json'],
    ]);
    for (const p of presets) {
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.docsHint.trim().length).toBeGreaterThan(0);
      expect(p.docsHint).not.toMatch(/\n/);
      if (p.defaultKeyHeader !== null) expect(p.defaultKeyHeader).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('presets are pure metadata', () => {
    for (const p of presets) expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('the tools array is well formed and lists exactly the v1 tool', () => {
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.map((t) => t.name)).toEqual([...toolNames]);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(typeof t.run).toBe('function');
      expect(typeof t.terminal).toBe('boolean');
    }
  });

  it('a typed ToolDefinition widens to the registry element type', async () => {
    const schema = z.object({ reason: z.string().max(200) });
    const typed: ToolDefinition<z.infer<typeof schema>> = {
      name: 'sample_tool',
      description: 'A sample tool for the type check.',
      inputSchema: schema,
      terminal: false,
      run: (input): Promise<ToolResult> => Promise.resolve({ modelText: `got ${input.reason}` }),
    };
    const widened: ToolDefinition = typed;
    const list: readonly ToolDefinition[] = [...tools, widened];
    expect(list.at(-1)?.name).toBe('sample_tool');
    expect(widened.inputSchema.safeParse({ reason: 'x' }).success).toBe(true);
    expect(widened.inputSchema.safeParse({}).success).toBe(false);
    const result = await typed.run(
      { reason: 'because' },
      {
        call: {
          callSid: 'CA1',
          sessionId: 'VX1',
          from: '+1',
          to: '+2',
          direction: 'inbound',
          channel: 'textchat',
          startedAt: new Date(0).toISOString(),
          custom: {},
        },
        history: [],
        settings: { HANDOFF_INCLUDE_TRANSCRIPT: false, AUTOMATION_TIMEOUT_MS: 5000 },
        log: { info: () => undefined } as unknown as Logger,
        signal: new AbortController().signal,
      },
    );
    expect(result.modelText).toBe('got because');
  });
});

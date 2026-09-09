import { describe, expect, it } from 'vitest';
import {
  advertisedProviderIds,
  createLlmClient,
  llmCatalog,
  providers,
} from '../../src/llm/registry.js';
import type { LlmEvent } from '../../src/llm/types.js';

/** The key variable names are part of the deployer-facing env schema. */
const expectedKeys: Record<string, string | null> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  fake: null,
};

async function drain(client: ReturnType<typeof createLlmClient>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of client.stream({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    timeoutMs: 1000,
    stallMs: 1000,
  })) {
    events.push(event);
  }
  return events;
}

describe('llm registry', () => {
  it('lists the six providers in order, fake last and unadvertised', () => {
    expect(providers.map((p) => p.id)).toEqual([
      'openai',
      'anthropic',
      'google',
      'mistral',
      'groq',
      'fake',
    ]);
    expect(advertisedProviderIds).toEqual(['openai', 'anthropic', 'google', 'mistral', 'groq']);
    expect(providers.find((p) => p.id === 'fake')?.advertised).toBe(false);
  });

  it('carries deployer-facing metadata that is plain text and value-free', () => {
    for (const p of providers) {
      expect(p.id).toMatch(/^[a-z0-9]+$/);
      expect(p.keyEnv).toBe(expectedKeys[p.id]);
      if (p.keyEnv !== null) expect(p.keyEnv).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/);
      expect(p.description.trim().length).toBeGreaterThan(0);
      expect(p.keyDescription.trim().length).toBeGreaterThan(0);
      expect(p.description).not.toMatch(/\n/);
      expect(p.keyDescription).not.toMatch(/\n/);
      expect(p.defaultModel.trim().length).toBeGreaterThan(0);
      expect(typeof p.create).toBe('function');
    }
  });

  it('exposes a catalog of metadata only, one entry per provider', () => {
    expect(llmCatalog.map((c) => c.id)).toEqual(providers.map((p) => p.id));
    for (const entry of llmCatalog) {
      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
      expect(Object.keys(entry).sort()).toEqual(
        ['advertised', 'defaultModel', 'description', 'id', 'keyDescription', 'keyEnv'].sort(),
      );
    }
  });

  it('createLlmClient resolves every id and defaults the model', () => {
    for (const p of providers) {
      const client = createLlmClient({ provider: p.id, apiKey: 'test-key' });
      expect(client.provider).toBe(p.id);
      expect(client.model).toBe(p.defaultModel);
      expect(createLlmClient({ provider: p.id, model: ' custom-model ', apiKey: 'k' }).model).toBe(
        'custom-model',
      );
      expect(createLlmClient({ provider: p.id, model: '   ', apiKey: 'k' }).model).toBe(
        p.defaultModel,
      );
    }
  });

  it('rejects an unknown provider with the advertised values and without echoing the input', () => {
    expect(() => createLlmClient({ provider: 'nope-secret', apiKey: 'k' })).toThrow(
      'Unknown LLM_PROVIDER. Valid values: openai, anthropic, google, mistral, groq.',
    );
    expect(() => createLlmClient({ provider: 'nope-secret', apiKey: 'k' })).not.toThrow(
      /nope-secret/,
    );
    expect(() => createLlmClient({ provider: 'nope', apiKey: 'k' })).not.toThrow(/fake/);
  });

  it('stub clients honour the LlmClient contract: one error event, probe not ok, never throws', async () => {
    const secret = 'sk-test-secret-0123456789';
    for (const p of providers) {
      const client = createLlmClient({ provider: p.id, apiKey: secret });
      const events = await drain(client);
      expect(events).toHaveLength(1);
      const [only] = events;
      expect(only?.type).toBe('error');
      if (only?.type === 'error') {
        expect(only.error.kind).toBe('unknown');
        expect(only.error.message).toContain(p.id);
        expect(only.error.message).not.toContain(secret);
      }
      const probe = await client.probe();
      expect(probe.ok).toBe(false);
      expect(probe.error?.kind).toBe('unknown');
    }
  });
});

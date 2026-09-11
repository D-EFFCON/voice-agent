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

  it('the scripted provider honours the LlmClient contract with no key and no network', async () => {
    const client = createLlmClient({ provider: 'fake', apiKey: '' });
    const events = await drain(client);

    // Streamed, not buffered: more than one delta, and exactly one terminal, at the end.
    expect(events.filter((e) => e.type === 'text-delta').length).toBeGreaterThan(1);
    expect(events.filter((e) => e.type === 'finish' || e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('finish');

    await expect(client.probe()).resolves.toMatchObject({ ok: true });
  });

  it('every advertised provider builds a client without touching the network', () => {
    // stream() and probe() are deliberately not called here: for a real provider they would make
    // an HTTP request. The event mapping, timeouts and failure sentences are covered against a
    // mock model in test/llm/aiSdkClient.test.ts, which needs no key.
    for (const p of providers.filter((provider) => provider.advertised)) {
      const client = createLlmClient({ provider: p.id, apiKey: 'sk-not-a-real-key' });
      expect(client.provider).toBe(p.id);
      expect(client.model).toBe(p.defaultModel);
      expect(typeof client.stream).toBe('function');
      expect(typeof client.probe).toBe('function');
    }
  });
});

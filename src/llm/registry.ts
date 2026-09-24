/**
 * The provider registry. Adding a provider is one file under providers/ plus one line in the
 * array below, then `pnpm docs:env`. Config derives the LLM_PROVIDER values and the key
 * variable names from llmCatalog, so it needs no edit.
 */
import { anthropic } from './providers/anthropic.js';
import { fake } from './providers/fake.js';
import { google } from './providers/google.js';
import { groq } from './providers/groq.js';
import { mistral } from './providers/mistral.js';
import { openai } from './providers/openai.js';
import { REASONING_SETTINGS, type ReasoningSetting } from './reasoning.js';
import { SPEED_SETTINGS, type SpeedSetting } from './speed.js';
import type { LlmClient, LlmProviderModule } from './types.js';

/**
 * Re-exported because config reaches src/llm through this file only (test/arch/imports.test.ts).
 * LLM_REASONING_EFFORT's and LLM_SPEED's valid values therefore follow the vocabularies, the same
 * way LLM_PROVIDER's follow llmCatalog.
 */
export { REASONING_SETTINGS, SPEED_SETTINGS };
export type { ReasoningSetting, SpeedSetting };

export const providers: readonly LlmProviderModule[] = [
  openai,
  anthropic,
  google,
  mistral,
  groq,
  fake,
];

/** Provider metadata without the factory: what config and the docs generator consume. */
export interface LlmCatalogEntry {
  id: string;
  advertised: boolean;
  description: string;
  keyEnv: string | null;
  keyDescription: string;
  defaultModel: string;
}

export type LlmCatalog = readonly LlmCatalogEntry[];

export const llmCatalog: LlmCatalog = providers.map(
  ({ id, advertised, description, keyEnv, keyDescription, defaultModel }) => ({
    id,
    advertised,
    description,
    keyEnv,
    keyDescription,
    defaultModel,
  }),
);

/** The LLM_PROVIDER values shown to deployers, in registry order. */
export const advertisedProviderIds: readonly string[] = providers
  .filter((p) => p.advertised)
  .map((p) => p.id);

/**
 * Builds the client for a provider id that config has already validated. An unknown id is a
 * wiring bug, so this throws; the message lists the advertised ids and never echoes the value.
 */
export function createLlmClient(o: {
  provider: string;
  model?: string;
  apiKey: string;
  /** LLM_REASONING_EFFORT; 'default' and undefined both leave the provider's own setting alone. */
  reasoning?: ReasoningSetting;
  /** LLM_SPEED; 'default' and undefined both leave the provider's own tier alone. */
  speed?: SpeedSetting;
}): LlmClient {
  const provider = providers.find((p) => p.id === o.provider);
  if (!provider) {
    throw new Error(`Unknown LLM_PROVIDER. Valid values: ${advertisedProviderIds.join(', ')}.`);
  }
  const requested = o.model?.trim() ?? '';
  const model = requested === '' ? provider.defaultModel : requested;
  const reasoning =
    o.reasoning === undefined || o.reasoning === 'default' ? undefined : o.reasoning;
  const speed = o.speed === undefined || o.speed === 'default' ? undefined : o.speed;
  return provider.create({
    model,
    apiKey: o.apiKey,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(speed === undefined ? {} : { speed }),
  });
}

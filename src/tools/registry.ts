/**
 * The tool and preset registries.
 *
 * Presets are pure metadata, so they stay a static array: config reads it to validate
 * AUTOMATION_PROVIDER and to find the default key header. Adding one is a file under
 * automation/presets/ plus a line in `presets`.
 *
 * Tools are built rather than listed, because a tool can need something only the composition root
 * has: handoff_to_team needs the automation client, and ToolContext (a locked seam) does not carry
 * it. Adding a tool is still one file plus one line, in `createTools`.
 */
import { make } from './automation/presets/make.js';
import { n8n } from './automation/presets/n8n.js';
import { none } from './automation/presets/none.js';
import { zapier } from './automation/presets/zapier.js';
import { createHandoffTool } from './handoffToTeam.js';
import type { AutomationClient, AutomationPreset, ToolDefinition } from './types.js';

export const presets: readonly AutomationPreset[] = [none, make, zapier, n8n];

/** Presets are pure metadata, so the array is the catalog config consumes. */
export type PresetCatalog = readonly AutomationPreset[];

export interface ToolRegistryDeps {
  automation: AutomationClient;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Every tool the model may call. v1 ships exactly one: end_call is an agent capability, not a tool,
 * so it is never listed here.
 */
export function createTools(deps: ToolRegistryDeps): readonly ToolDefinition[] {
  return [
    createHandoffTool({
      automation: deps.automation,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  ];
}

/** The names v1 offers, for the docs and for tests that need them without building the tools. */
export const toolNames: readonly string[] = ['handoff_to_team'];

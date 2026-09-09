/**
 * The tool and preset registries. Adding a tool is one file plus one line in `tools`; adding
 * a preset is one file under automation/presets/ plus one line in `presets`. Config derives
 * the AUTOMATION_PROVIDER values and the default key header from `presets`.
 */
import { make } from './automation/presets/make.js';
import { n8n } from './automation/presets/n8n.js';
import { none } from './automation/presets/none.js';
import { zapier } from './automation/presets/zapier.js';
import type { AutomationPreset, ToolDefinition } from './types.js';

/**
 * v1 ships exactly one registry tool, handoff_to_team, added here by
 * tools-and-automation-webhook. end_call is an agent capability, never listed here.
 */
export const tools: readonly ToolDefinition[] = [];

export const presets: readonly AutomationPreset[] = [none, make, zapier, n8n];

/** Presets are pure metadata, so the array is the catalog config consumes. */
export type PresetCatalog = readonly AutomationPreset[];

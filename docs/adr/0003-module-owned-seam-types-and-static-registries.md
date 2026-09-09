# Module-owned seam types with static registries; the agent core imports only types

The promise to contributors is "add a provider, tool or adapter as one file plus one registry line, never touching `src/agent/`". To keep that literal, each seam owns its types next to a static registry array (`src/llm/types.ts` with `src/llm/registry.ts`, and the same for `src/tools/` and `src/voice/`), the agent core imports only those type files, `src/main.ts` is the only file that imports concrete providers, presets and adapters, and a Vitest over import specifiers enforces the matrix. Config derives its valid enum values and key names from the registries, so a new provider needs no config edit.

## Considered options

Agent-owned hexagonal ports were rejected because a contributor would touch two folders. Directory-scan discovery was rejected because it fails at runtime instead of at typecheck. Reversing this decision later means moving every seam, which is why it is recorded.

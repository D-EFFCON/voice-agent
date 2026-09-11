/**
 * Generates `.env.example` and the README environment section from src/config/schema.ts.
 *
 *   pnpm docs:env          write both files
 *   pnpm docs:env --check  exit 1 when either file is out of date (CI runs this)
 *
 * The specs, the render functions and the README markers live in src/config; this file only
 * touches the disk. After adding a provider or a preset, run `pnpm docs:env` and commit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  envSchema,
  renderEnvExample,
  renderReadmeSection,
  replaceBetween,
} from '../src/config/index.js';
import { llmCatalog } from '../src/llm/registry.js';
import { presets } from '../src/tools/registry.js';

const root = resolve(import.meta.dirname, '..');
const envPath = resolve(root, '.env.example');
const readmePath = resolve(root, 'README.md');

const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const { list } = envSchema({ llm: llmCatalog, automation: presets });
const wantEnv = renderEnvExample(list);
const currentReadme = readFileSync(readmePath, 'utf8');
const wantReadme = replaceBetween(currentReadme, renderReadmeSection(list));

if (process.argv.includes('--check')) {
  const stale: string[] = [];
  if (read(envPath) !== wantEnv) stale.push('.env.example');
  if (currentReadme !== wantReadme) stale.push('README.md');
  if (stale.length > 0) {
    console.error(`docs:env: out of date: ${stale.join(', ')}. Run pnpm docs:env and commit.`);
    process.exit(1);
  }
  console.log('docs:env: .env.example and README.md are up to date.');
} else {
  writeFileSync(envPath, wantEnv);
  writeFileSync(readmePath, wantReadme);
  console.log('docs:env: wrote .env.example and README.md.');
}

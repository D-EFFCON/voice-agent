/**
 * The import boundary (blueprint contract "Import boundary (architecture test)", ADR 0003).
 *
 * Every file under src/ is parsed with the TypeScript compiler and each import specifier is
 * checked against the allowed matrix. Value imports follow the per-module table; type-only
 * imports of a seam file (src/<module>/types.ts) are allowed from every module except src/llm,
 * which imports nothing internal. 'ai' and '@ai-sdk/*' may appear only in
 * src/llm/aiSdkClient.ts. Nothing imports src/main.ts, and only src/main.ts imports src/app.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..', '..', 'src');

export interface ImportRef {
  specifier: string;
  typeOnly: boolean;
  line: number;
}

// --- Parsing --------------------------------------------------------------------------------

export function collectImports(fileName: string, text: string): ImportRef[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const refs: ImportRef[] = [];
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let typeOnly = clause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      if (!typeOnly && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements;
        typeOnly = !clause.name && elements.length > 0 && elements.every((e) => e.isTypeOnly);
      }
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly, line: lineOf(node) });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      let typeOnly = node.isTypeOnly;
      if (!typeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
        const elements = node.exportClause.elements;
        typeOnly = elements.length > 0 && elements.every((e) => e.isTypeOnly);
      }
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly, line: lineOf(node) });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      refs.push({
        specifier: node.moduleReference.expression.text,
        typeOnly: node.isTypeOnly,
        line: lineOf(node),
      });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        refs.push({ specifier: arg.text, typeOnly: false, line: lineOf(node) });
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      refs.push({ specifier: node.argument.literal.text, typeOnly: true, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
}

// --- The matrix -----------------------------------------------------------------------------

/** Value imports allowed per module: a module directory, a directory path or an exact file. */
const valueAllowed: Record<string, readonly string[]> = {
  config: ['llm/registry.ts', 'tools/registry.ts'],
  log: ['config'],
  security: ['config', 'log'],
  llm: [],
  tools: ['config', 'log'],
  agent: ['log'],
  voice: ['agent', 'security', 'config', 'log'],
  status: ['config', 'security', 'voice/textchat', 'log'],
  'app.ts': ['config', 'log', 'security'],
};

/** Extra targets allowed only as type-only imports. */
const typeOnlyAllowed: Record<string, readonly string[]> = {
  agent: ['config'],
};

const bannedExternals: Record<string, readonly RegExp[]> = {
  agent: [/^fastify$/, /^fastify\//, /^@fastify\//, /^ai$/, /^ai\//, /^@ai-sdk\//],
};

const aiSdk = [/^ai$/, /^ai\//, /^@ai-sdk\//];
const aiSdkFile = 'llm/aiSdkClient.ts';
const seamTypesFile = /^[a-z]+\/types\.ts$/;

type Target =
  | { kind: 'internal'; path: string }
  | { kind: 'external'; name: string }
  | { kind: 'outside'; path: string };

/** file paths are posix and relative to src/, e.g. 'agent/session.ts'. */
export function resolveTarget(fromFile: string, specifier: string): Target {
  if (!specifier.startsWith('.')) return { kind: 'external', name: specifier };
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  if (joined.startsWith('../') || joined === '..') return { kind: 'outside', path: joined };
  const path = joined.replace(/\.js$/, '.ts');
  return { kind: 'internal', path };
}

export function moduleOf(file: string): string {
  const [first] = file.split('/');
  return first ?? file;
}

function matches(target: string, rule: string): boolean {
  if (rule.endsWith('.ts')) return target === rule;
  return target === rule || target.startsWith(`${rule}/`);
}

export function violationsFor(file: string, imports: ImportRef[]): string[] {
  const mod = moduleOf(file);
  const out: string[] = [];
  for (const imp of imports) {
    const where = `src/${file}:${imp.line} imports '${imp.specifier}'`;
    const target = resolveTarget(file, imp.specifier);
    if (target.kind === 'outside') {
      out.push(`${where}: src/ never imports outside src/`);
      continue;
    }
    if (target.kind === 'external') {
      if (aiSdk.some((re) => re.test(target.name)) && file !== aiSdkFile) {
        out.push(`${where}: only src/${aiSdkFile} may import the AI SDK`);
      }
      for (const re of bannedExternals[mod] ?? []) {
        if (re.test(target.name)) out.push(`${where}: ${mod} must not import ${target.name}`);
      }
      continue;
    }
    if (mod === 'main.ts') continue;
    if (target.path === 'main.ts') {
      out.push(`${where}: nothing imports src/main.ts`);
      continue;
    }
    if (target.path === 'app.ts') {
      out.push(`${where}: only src/main.ts imports src/app.ts`);
      continue;
    }
    if (moduleOf(target.path) === mod) continue;
    if (imp.typeOnly && mod !== 'llm' && seamTypesFile.test(target.path)) continue;
    if ((valueAllowed[mod] ?? []).some((rule) => matches(target.path, rule))) continue;
    if (imp.typeOnly && (typeOnlyAllowed[mod] ?? []).some((rule) => matches(target.path, rule))) {
      continue;
    }
    out.push(
      `${where}: ${mod} may not import ${target.path}${imp.typeOnly ? ' (even type-only)' : ''}`,
    );
  }
  return out;
}

// --- Walking src/ ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function scanSrc(): { file: string; imports: ImportRef[] }[] {
  return sourceFiles(SRC)
    .map((full) => relative(SRC, full).split(sep).join('/'))
    .sort()
    .map((file) => ({
      file,
      imports: collectImports(file, readFileSync(resolve(SRC, file), 'utf8')),
    }));
}

// --- Tests ----------------------------------------------------------------------------------

describe('import boundary', () => {
  it('every file under src/ obeys the allowed import matrix', () => {
    const scanned = scanSrc();
    expect(scanned.length).toBeGreaterThan(0);
    const violations = scanned.flatMap(({ file, imports }) => violationsFor(file, imports));
    expect(violations).toEqual([]);
  });

  it('sees the imports this foundation is known to make', () => {
    const byFile = new Map(scanSrc().map(({ file, imports }) => [file, imports]));
    const registry = byFile.get('llm/registry.ts') ?? [];
    expect(registry).toContainEqual(
      expect.objectContaining({ specifier: './providers/openai.js', typeOnly: false }),
    );
    expect(registry).toContainEqual(
      expect.objectContaining({ specifier: './types.js', typeOnly: true }),
    );
    const tools = byFile.get('tools/types.ts') ?? [];
    expect(tools).toContainEqual(
      expect.objectContaining({ specifier: '../agent/types.js', typeOnly: true }),
    );
    expect(byFile.has('main.ts')).toBe(true);
    expect(byFile.has('app.ts')).toBe(true);
    expect(byFile.has('log/index.ts')).toBe(true);
    expect(byFile.get('app.ts') ?? []).toContainEqual(
      expect.objectContaining({ specifier: './log/index.js', typeOnly: true }),
    );
    expect(byFile.get('main.ts') ?? []).toContainEqual(
      expect.objectContaining({ specifier: './log/index.js', typeOnly: false }),
    );
    expect(byFile.get('log/redact.ts') ?? []).toContainEqual(
      expect.objectContaining({ specifier: '../config/index.js', typeOnly: false }),
    );
  });
});

describe('collectImports', () => {
  it('classifies every import form and tells type-only from value imports', () => {
    const text = [
      "import type { A } from './a.js';",
      "import { type B } from './b.js';",
      "import { C, type D } from './c.js';",
      "import E from './e.js';",
      "import * as F from './f.js';",
      "export type { G } from './g.js';",
      "export { type H } from './h.js';",
      "export * from './i.js';",
      "export { J } from './j.js';",
      "const k = await import('./k.js');",
      "type L = import('./l.js').L;",
      "import ts from 'typescript';",
      "import type { M } from '@ai-sdk/openai';",
    ].join('\n');
    const refs = collectImports('x.ts', text).map(({ specifier, typeOnly }) => ({
      specifier,
      typeOnly,
    }));
    expect(refs).toEqual([
      { specifier: './a.js', typeOnly: true },
      { specifier: './b.js', typeOnly: true },
      { specifier: './c.js', typeOnly: false },
      { specifier: './e.js', typeOnly: false },
      { specifier: './f.js', typeOnly: false },
      { specifier: './g.js', typeOnly: true },
      { specifier: './h.js', typeOnly: true },
      { specifier: './i.js', typeOnly: false },
      { specifier: './j.js', typeOnly: false },
      { specifier: './k.js', typeOnly: false },
      { specifier: './l.js', typeOnly: true },
      { specifier: 'typescript', typeOnly: false },
      { specifier: '@ai-sdk/openai', typeOnly: true },
    ]);
  });
});

describe('violationsFor', () => {
  const value = (specifier: string): ImportRef => ({ specifier, typeOnly: false, line: 1 });
  const typeOnly = (specifier: string): ImportRef => ({ specifier, typeOnly: true, line: 1 });
  const ok = (file: string, ...imports: ImportRef[]): void => {
    expect(violationsFor(file, imports)).toEqual([]);
  };
  const bad = (file: string, ...imports: ImportRef[]): void => {
    expect(violationsFor(file, imports)).not.toEqual([]);
  };

  it('agent imports only seam types, config types and log', () => {
    ok(
      'agent/session.ts',
      typeOnly('../llm/types.js'),
      typeOnly('../tools/types.js'),
      typeOnly('../voice/types.js'),
    );
    ok('agent/session.ts', typeOnly('../config/index.js'), value('../log/index.js'));
    ok('agent/session.ts', value('./capabilities/endCall.js'), value('pino'));
    bad('agent/session.ts', value('../llm/types.js'));
    bad('agent/session.ts', value('../llm/providers/openai.js'));
    bad('agent/session.ts', value('../llm/registry.js'));
    bad('agent/session.ts', value('../config/index.js'));
    bad('agent/session.ts', value('../voice/conversationrelay/link.js'));
    bad('agent/session.ts', value('../security/gate.js'));
    bad('agent/session.ts', value('../status/page.js'));
    bad('agent/session.ts', value('fastify'));
    bad('agent/session.ts', value('@fastify/websocket'));
    bad('agent/session.ts', value('ai'));
    bad('agent/session.ts', value('@ai-sdk/openai'));
  });

  it('llm imports nothing internal, and only aiSdkClient imports the AI SDK', () => {
    ok('llm/aiSdkClient.ts', value('ai'), value('@ai-sdk/openai'), value('./types.js'));
    ok('llm/providers/openai.ts', value('../stub.js'), typeOnly('../types.js'));
    bad('llm/providers/openai.ts', value('ai'));
    bad('llm/providers/openai.ts', value('@ai-sdk/openai'));
    bad('llm/registry.ts', value('../log/index.js'));
    bad('llm/types.ts', typeOnly('../agent/types.js'));
    bad('status/page.ts', value('ai'));
  });

  it('tools reach config, log and seam types only', () => {
    ok(
      'tools/types.ts',
      typeOnly('../voice/types.js'),
      typeOnly('../llm/types.js'),
      typeOnly('../agent/types.js'),
    );
    ok(
      'tools/handoff-to-team.ts',
      value('../config/index.js'),
      value('../log/index.js'),
      value('zod'),
    );
    bad('tools/handoff-to-team.ts', value('../agent/session.js'));
    bad('tools/handoff-to-team.ts', value('../voice/types.js'));
  });

  it('config reads registry metadata only', () => {
    ok(
      'config/schema.ts',
      value('../llm/registry.js'),
      value('../tools/registry.js'),
      typeOnly('../llm/types.js'),
    );
    bad('config/schema.ts', value('../llm/providers/openai.js'));
    bad('config/schema.ts', value('../log/index.js'));
  });

  it('voice and status follow their rows', () => {
    ok(
      'voice/conversationrelay/route.ts',
      value('../../agent/session.js'),
      value('../../security/gate.js'),
      value('../../config/index.js'),
      value('../../log/index.js'),
    );
    bad('voice/conversationrelay/route.ts', value('../../status/page.js'));
    bad('voice/conversationrelay/route.ts', value('../../llm/registry.js'));
    ok(
      'status/page.ts',
      value('../voice/textchat/adapter.js'),
      typeOnly('../agent/types.js'),
      typeOnly('../llm/types.js'),
      typeOnly('../tools/types.js'),
    );
    bad('status/page.ts', value('../agent/session.js'));
    bad('status/page.ts', value('../voice/index.js'));
  });

  it('app.ts and main.ts', () => {
    ok(
      'app.ts',
      value('./config/index.js'),
      value('./log/index.js'),
      value('./security/headers.js'),
    );
    bad('app.ts', value('./agent/session.js'));
    ok(
      'main.ts',
      value('./app.js'),
      value('./llm/registry.js'),
      value('./voice/index.js'),
      value('./status/index.js'),
    );
    bad('status/index.ts', value('../app.js'));
    bad('voice/index.ts', value('../main.js'));
  });

  it('rejects imports outside src/ and modules missing from the matrix', () => {
    bad('agent/session.ts', value('../../test/helpers/index.js'));
    bad('util/x.ts', value('../config/index.js'));
    bad('config/schema.ts', value('../util/x.js'));
  });
});

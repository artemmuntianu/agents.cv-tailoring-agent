#!/usr/bin/env node
/**
 * Type-aware analysis + codemod CLI for PlayGround Portal (ts-morph).
 *
 *   install once per clone:  cmd /c "cd /d tools && npm install"
 *   run:                     node tools/analyze.mjs <command> [args]
 *
 * Commands
 *   outline <file>                        declaration map (kind, name, line range, JSDoc first line)
 *   dead-exports [--all]                  exports with no reference outside their own file
 *   refs <SymbolName> [--file <path>]     real reference resolution (language service), not text search
 *   imports <module>                      who imports a module, and what they pull from it
 *   typecheck                             tsc diagnostics (tsc --noEmit stays the source of truth)
 *   move-symbols --from a.ts --to b.ts --names f,g [--write]
 *                                         codemod: move top-level declarations + rewire every import;
 *                                         DRY RUN unless --write
 *
 * Why this exists: a regex scan counts matches inside comments and strings and cannot see the symbol
 * graph. Use this instead of ad-hoc greps for "who references X?", "what is dead?", "move these".
 */
import { Project, Node, SyntaxKind } from 'ts-morph';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Astro resolves these by name convention, not by an import: they are never "dead". */
const FRAMEWORK_EXPORTS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL',
  'prerender', 'getStaticPaths', 'getStaticProps', 'default',
]);
/** Source files that the TS program does NOT include (Astro pages/layouts, plain JS). */
const OUTSIDE_TS = /\.(astro|js|mjs|cjs)$/;
/** Documentation: a mention in a doc is NOT a reference, but it is worth reporting. */
const DOC_FILES = /\.md$/;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const command = argv[0];

function createProject() {
  return new Project({ tsConfigFilePath: path.join(ROOT, 'tsconfig.json') });
}
function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
function positionals() {
  return argv.slice(1).filter((a) => !a.startsWith('--'));
}
function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}
function die(message) {
  console.error(`analyze: ${message}`);
  process.exit(1);
}
/** Resolves a path argument ("src/lib/segRenderer", "src/lib/x.ts", "src/lib" -> index.ts). */
function resolveFile(project, target) {
  if (!target) die('a file path is required');
  const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}.d.ts`, path.join(target, 'index.ts')];
  for (const candidate of candidates) {
    const file = project.getSourceFile(path.resolve(ROOT, candidate));
    if (file) return file;
  }
  die(`not part of the project (check path/extension): ${target}`);
}

const NAMED_DECLARATIONS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.VariableDeclaration,
];

/** Every declaration in `file` (top-level or nested) that carries the given name. */
function declarationsNamed(file, name) {
  const out = [];
  for (const kind of NAMED_DECLARATIONS) {
    for (const node of file.getDescendantsOfKind(kind)) {
      const nodeName = typeof node.getName === 'function' ? node.getName() : undefined;
      if (nodeName === name) out.push(node);
    }
  }
  return out;
}

/** Top-level statement that declares `name` (a whole VariableStatement for const blocks). */
function topLevelDeclaration(file, name) {
  for (const statement of file.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      if (statement.getDeclarations().some((d) => d.getName() === name)) return statement;
      continue;
    }
    if (typeof statement.getName === 'function' && statement.getName() === name) return statement;
  }
  return null;
}

/** Names this module exports itself (re-exports excluded) -> declaration node. */
function localExports(file) {
  const out = new Map();
  for (const statement of file.getStatements()) {
    if (typeof statement.isExported !== 'function' || !statement.isExported()) continue;
    if (Node.isVariableStatement(statement)) {
      for (const decl of statement.getDeclarations()) out.set(decl.getName(), decl);
      continue;
    }
    const name = typeof statement.getName === 'function' ? statement.getName() : undefined;
    if (name) out.set(name, statement);
  }
  return out;
}

/**
 * Identifiers used by files outside the TS program (.astro pages/layouts, scripts, plain JS).
 *
 * Without this, every component that only an `.astro` page imports looks dead, because ts-morph only
 * sees the TS project. Conservative on purpose: any textual occurrence counts as a reference.
 */
function scanFileNames(matcher) {
  const found = new Map();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!matcher.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
        if (!found.has(match[0])) found.set(match[0], rel(full));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'scripts'));
  return found;
}

/** Identifiers used by files the TS program does not include (`.astro` pages/layouts, plain JS). */
function referencesOutsideTs() {
  return scanFileNames(OUTSIDE_TS);
}

/** Identifiers merely mentioned in the docs (informational: a doc is not a reference). */
function referencesInDocs() {
  return scanFileNames(DOC_FILES);
}

function outline(target) {
  const project = createProject();
  const file = resolveFile(project, target);
  console.log(`${rel(file.getFilePath())}  (${file.getStatements().length} top-level statements)`);
  for (const statement of file.getStatements()) {
    let kind = SyntaxKind[statement.getKind()];
    let name = '(anonymous)';
    if (Node.isImportDeclaration(statement)) {
      kind = 'import';
      name = statement.getModuleSpecifierValue();
    } else if (Node.isExportDeclaration(statement)) {
      kind = 'export';
      name = statement.getModuleSpecifierValue() || '(bare export)';
    } else if (Node.isVariableStatement(statement)) {
      kind = 'const/let';
      name = statement.getDeclarations().map((d) => d.getName()).join(', ');
    } else if (typeof statement.getName === 'function' && statement.getName()) {
      name = statement.getName();
    }
    const exported = typeof statement.isExported === 'function' && statement.isExported() ? 'export ' : '      ';
    const doc = statement.getJsDocs?.()[0]?.getDescription?.().trim().split('\n')[0] ?? '';
    console.log(
      `  ${String(statement.getStartLineNumber()).padStart(4)}-${String(statement.getEndLineNumber()).padEnd(4)} ${exported}${kind.padEnd(20)} ${name}${doc ? `   // ${doc.slice(0, 64)}` : ''}`
    );
  }
}

function deadExports(showAll) {
  const project = createProject();
  const files = project.getSourceFiles();
  // AST-accurate identifier counts per (name, file): comments and strings are not identifiers.
  const counts = new Map();
  for (const file of files) {
    file.forEachDescendant((node) => {
      if (!node.isKind(SyntaxKind.Identifier)) return;
      const name = node.getText();
      let perFile = counts.get(name);
      if (!perFile) counts.set(name, (perFile = new Map()));
      perFile.set(file.getFilePath(), (perFile.get(file.getFilePath()) ?? 0) + 1);
    });
  }

  const dead = [];
  const internalOnly = [];
  const framework = [];
  const outside = [];
  const outsideTs = referencesOutsideTs();
  const docs = referencesInDocs();
  for (const file of files) {
    const selfPath = file.getFilePath();
    for (const [name, decl] of localExports(file)) {
      const perFile = counts.get(name) ?? new Map();
      let external = 0;
      for (const [filePath, count] of perFile) if (filePath !== selfPath) external += count;
      const internal = (perFile.get(selfPath) ?? 0) - 1; // minus the declaration's own name node
      const at = `${rel(selfPath)}:${decl.getStartLineNumber()}`;
      if (external !== 0) continue;
      if (internal > 0) internalOnly.push({ name, at, internal });
      else if (FRAMEWORK_EXPORTS.has(name)) framework.push({ name, at });
      else if (outsideTs.has(name)) outside.push({ name, at, where: outsideTs.get(name) });
      else dead.push({ name, at, doc: docs.get(name) });
    }
  }

  console.log(`FULLY DEAD (no reference in TS, .astro or scripts) - ${dead.length}`);
  for (const row of dead) {
    console.log(`  ${row.name.padEnd(30)} ${row.at}${row.doc ? `   (only mentioned in ${row.doc})` : ''}`);
  }
  console.log(`\nFRAMEWORK-RESOLVED (Astro API verbs / prerender: never imported by design) - ${framework.length}`);
  for (const row of framework) console.log(`  ${row.name.padEnd(30)} ${row.at}`);
  console.log(`\nUSED OUTSIDE THE TS PROGRAM (.astro pages/layouts, scripts) - ${outside.length}`);
  for (const row of outside) console.log(`  ${row.name.padEnd(30)} ${row.at}   <- ${row.where}`);
  console.log(`\nINTERNAL-ONLY (used only inside its own file) - ${internalOnly.length}`);
  for (const row of internalOnly.sort((a, b) => a.internal - b.internal)) {
    if (!showAll && row.internal > 2) continue;
    console.log(`  internalUses=${String(row.internal).padStart(2)}  ${row.name.padEnd(30)} ${row.at}`);
  }
  if (!showAll) console.log('  (pass --all to list every internal-only export)');
}

function refs(name, onlyFile) {
  if (!name) die('usage: analyze.mjs refs <SymbolName> [--file <path>]');
  const project = createProject();
  const definitions = [];
  for (const file of project.getSourceFiles()) {
    if (onlyFile && !rel(file.getFilePath()).endsWith(onlyFile.replace(/\\/g, '/'))) continue;
    for (const decl of declarationsNamed(file, name)) definitions.push(decl);
  }
  if (!definitions.length) die(`no declaration named "${name}" found`);

  for (const decl of definitions) {
    console.log(`\n${decl.getKindName()} ${name} - ${rel(decl.getSourceFile().getFilePath())}:${decl.getStartLineNumber()}`);
    const byFile = new Map();
    let total = 0;
    for (const referenced of decl.findReferences()) {
      for (const entry of referenced.getReferences()) {
        if (typeof entry.isDefinition === 'function' && entry.isDefinition()) continue;
        const node = entry.getNode();
        const key = rel(node.getSourceFile().getFilePath());
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(node.getStartLineNumber());
        total++;
      }
    }
    if (!total) {
      console.log('  (no references - dead)');
      continue;
    }
    for (const [filePath, lines] of [...byFile].sort()) {
      console.log(`  ${filePath}: ${[...new Set(lines)].sort((a, b) => a - b).join(', ')}`);
    }
    console.log(`  total: ${total} reference(s) in ${byFile.size} file(s)`);
  }
}

function imports(target) {
  if (!target) die('usage: analyze.mjs imports <modulePath>');
  const project = createProject();
  const targetFile = resolveFile(project, target);
  const targetPath = targetFile.getFilePath();
  let importers = 0;
  for (const file of project.getSourceFiles()) {
    if (file.getFilePath() === targetPath) continue;
    const lines = [];
    for (const imp of file.getImportDeclarations()) {
      if (imp.getModuleSpecifierSourceFile()?.getFilePath() !== targetPath) continue;
      const named = imp.getNamedImports().map((n) =>
        typeof n.isTypeOnly === 'function' && n.isTypeOnly() ? `type ${n.getName()}` : n.getName()
      );
      const parts = [
        imp.getDefaultImport()?.getText(),
        imp.getNamespaceImport() ? `* as ${imp.getNamespaceImport().getText()}` : null,
        named.length ? `{ ${named.join(', ')} }` : null,
      ].filter(Boolean);
      lines.push(`  L${imp.getStartLineNumber()}: import ${parts.join(', ')} from '${imp.getModuleSpecifierValue()}'`);
    }
    for (const exp of file.getExportDeclarations()) {
      if (exp.getModuleSpecifierSourceFile()?.getFilePath() !== targetPath) continue;
      lines.push(`  L${exp.getStartLineNumber()}: re-export from '${exp.getModuleSpecifierValue()}'`);
    }
    if (lines.length) {
      importers++;
      console.log(rel(file.getFilePath()));
      for (const line of lines) console.log(line);
    }
  }
  console.log(importers ? `\n${importers} importer(s) of ${rel(targetPath)}` : `nothing imports ${rel(targetPath)}`);
}

/** Relative import specifier (extension-less, POSIX separators) from one file to another. */
function relativeSpecifier(fromFile, toFile) {
  let spec = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, '/');
  spec = spec.replace(/\.(ts|tsx)$/, '');
  return spec.startsWith('.') ? spec : `./${spec}`;
}

/**
 * Moves top-level declarations between modules and rewires every importer.
 * Dry run by default: it prints the plan, the follow-up imports the target needs and the
 * back-import the source file may now need. `--write` applies, then run `typecheck`.
 */
function moveSymbols({ from, to, names, write }) {
  if (!from || !to || !names.length) {
    die('usage: analyze.mjs move-symbols --from a.ts --to b.ts --names f,g [--write]');
  }
  const project = createProject();
  const fromFile = resolveFile(project, from);
  const toPath = path.resolve(ROOT, to);
  const toFile = project.getSourceFile(toPath) || project.createSourceFile(toPath);

  const moves = [];
  for (const name of names) {
    const decl = topLevelDeclaration(fromFile, name);
    if (!decl) die(`"${name}" is not a top-level declaration of ${rel(fromFile.getFilePath())}`);
    if (Node.isVariableStatement(decl) && decl.getDeclarations().length > 1) {
      const all = decl.getDeclarations().map((d) => d.getName());
      if (!all.every((n) => names.includes(n))) {
        die(`"${name}" shares one const statement with ${all.join(', ')} — split it or move them together`);
      }
    }
    moves.push({ name, text: decl.getFullText().trim(), decl });
  }

  const importers = [];
  for (const file of project.getSourceFiles()) {
    if (file.getFilePath() === fromFile.getFilePath()) continue;
    for (const imp of file.getImportDeclarations()) {
      if (imp.getModuleSpecifierSourceFile()?.getFilePath() !== fromFile.getFilePath()) continue;
      const affected = imp.getNamedImports().filter((n) => names.includes(n.getName()));
      if (affected.length) importers.push({ file, imp, affected });
    }
  }

  const movedText = moves.map((m) => m.text).join('\n');
  const movedIdentifiers = new Set(movedText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []);
  const stillNeededFromSource = [...localExports(fromFile).keys()].filter(
    (n) => !names.includes(n) && movedIdentifiers.has(n)
  );
  const neededImports = [];
  for (const imp of fromFile.getImportDeclarations()) {
    const defaultName = imp.getDefaultImport()?.getText() || imp.getNamespaceImport()?.getText();
    if (defaultName && movedIdentifiers.has(defaultName)) {
      neededImports.push(`${defaultName} from '${imp.getModuleSpecifierValue()}'`);
    }
    for (const spec of imp.getNamedImports()) {
      if (movedIdentifiers.has(spec.getName())) {
        neededImports.push(`${spec.getName()} from '${imp.getModuleSpecifierValue()}'`);
      }
    }
  }
  // What the source file will still say once the declarations are gone (a moved declaration's own
  // name must not count as a back-reference).
  let remainingText = fromFile.getFullText();
  for (const m of moves) remainingText = remainingText.replace(m.decl.getFullText(), '');
  const backReferences = names.filter((n) => new RegExp(`\\b${n}\\b`).test(remainingText));

  console.log(`move ${names.join(', ')}:  ${rel(fromFile.getFilePath())} -> ${rel(toFile.getFilePath())}`);
  for (const m of moves) {
    console.log(`  declaration ${m.name} (${m.decl.getKindName()}, L${m.decl.getStartLineNumber()}-${m.decl.getEndLineNumber()})`);
  }
  console.log(`  importers to rewire: ${importers.length}`);
  for (const i of importers) {
    console.log(`    ${rel(i.file.getFilePath())} L${i.imp.getStartLineNumber()} ${i.affected.map((n) => n.getName()).join(', ')}`);
  }
  if (stillNeededFromSource.length) {
    console.log(`  TARGET needs: import { ${stillNeededFromSource.join(', ')} } from './${path.basename(rel(fromFile.getFilePath())).replace(/\.ts$/, '')}'`);
  }
  if (neededImports.length) console.log(`  TARGET needs (external): ${neededImports.join('; ')}`);
  if (backReferences.length) console.log(`  SOURCE may now need a back-import from the target: ${backReferences.join(', ')}`);

  if (!write) {
    console.log('\nDRY RUN - nothing written. Re-run with --write to apply, then run `analyze.mjs typecheck`.');
    return;
  }

  for (const m of moves) {
    toFile.addStatements(m.text);
    m.decl.remove();
  }
  for (const { file, imp, affected } of importers) {
    const specifier = relativeSpecifier(file.getFilePath(), toFile.getFilePath());
    const types = affected.map((n) =>
      typeof n.isTypeOnly === 'function' && n.isTypeOnly() ? { name: n.getName(), isTypeOnly: true } : n.getName()
    );
    for (const n of affected) n.remove();
    const isEmpty =
      !imp.getNamedImports().length && !imp.getDefaultImport() && !imp.getNamespaceImport();
    if (isEmpty) imp.remove();
    // The target itself may also have been an importer: the symbol is now local there, so it must
    // NOT get a self-import (the stale import was already dropped above).
    if (file.getFilePath() === toFile.getFilePath()) continue;
    let target = file.getImportDeclarations().find((d) => d.getModuleSpecifierValue() === specifier);
    if (!target) target = file.addImportDeclaration({ moduleSpecifier: specifier });
    target.addNamedImports(types);
  }
  project.saveSync();
  console.log('applied. Now run: node tools/analyze.mjs typecheck   (or cmd /c "npm run typecheck")');
}

function typecheck() {
  const project = createProject();
  const diagnostics = project.getPreEmitDiagnostics();
  if (!diagnostics.length) {
    console.log('analyze: no TypeScript diagnostics');
    return;
  }
  for (const diagnostic of diagnostics) {
    const file = diagnostic.getSourceFile();
    const where = file
      ? `${rel(file.getFilePath())}:${file.getLineAndColumnAtPos(diagnostic.getStart()).line}`
      : 'project';
    const text = diagnostic.getMessageText();
    console.log(`${where}  ${typeof text === 'string' ? text : text.getMessageText()}`);
  }
  console.log(`analyze: ${diagnostics.length} diagnostic(s) — tsc --noEmit stays authoritative`);
  process.exit(1);
}

switch (command) {
  case 'outline':
    outline(positionals()[0]);
    break;
  case 'dead-exports':
    deadExports(flag('all'));
    break;
  case 'refs':
    refs(positionals()[0], opt('file'));
    break;
  case 'imports':
    imports(positionals()[0]);
    break;
  case 'typecheck':
    typecheck();
    break;
  case 'move-symbols':
    moveSymbols({
      from: opt('from'),
      to: opt('to'),
      names: (opt('names') || '').split(',').map((s) => s.trim()).filter(Boolean),
      write: flag('write'),
    });
    break;
  default:
    console.log('usage: node tools/analyze.mjs <outline|dead-exports|refs|imports|typecheck|move-symbols> [args]');
    console.log('see tools/README.md for examples');
    process.exit(command ? 1 : 0);
}

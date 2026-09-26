#!/usr/bin/env python
"""
AST-based analysis & layer validator CLI for Python repositories (CVTailoringAgent).

Usage:
  python tools/analyze.py outline <file.py>
  python tools/analyze.py context <file.py>
  python tools/analyze.py impact <file.py>
  python tools/analyze.py syntax-check <file.py>
  python tools/analyze.py validate-docs
"""
import ast
import os
import re
import sys

# Ensure UTF-8 output on Windows cp1252 console
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

ROOT = os.getcwd()


def _rel(path):
    return os.path.relpath(path, ROOT).replace("\\", "/")


def outline(file_path):
    full_path = os.path.join(ROOT, file_path) if not os.path.isabs(file_path) else file_path
    if not os.path.exists(full_path):
        print(f"analyze error: file not found: {file_path}")
        sys.exit(1)

    with open(full_path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=full_path)

    print(f"Outline for {_rel(full_path)}:")
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            doc = ast.get_docstring(node)
            first_line = doc.split("\n")[0] if doc else ""
            print(f"  def {node.name}() (line {node.lineno}){f' — {first_line}' if first_line else ''}")
        elif isinstance(node, ast.ClassDef):
            doc = ast.get_docstring(node)
            first_line = doc.split("\n")[0] if doc else ""
            print(f"  class {node.name} (line {node.lineno}){f' — {first_line}' if first_line else ''}")


def context(file_path):
    full_path = os.path.join(ROOT, file_path) if not os.path.isabs(file_path) else file_path
    if not os.path.exists(full_path):
        print(f"analyze error: file not found: {file_path}")
        sys.exit(1)

    with open(full_path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=full_path)

    print(f"=== TOKEN-EFFICIENT INTERFACE SUMMARY: {_rel(full_path)} ===")
    imports = []
    exports = []

    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(f"import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            imports.append(f"from {node.module or ''} import {', '.join(a.name for a in node.names)}")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = [a.arg for a in node.args.args]
            ret = ast.unparse(node.returns) if node.returns else "Any"
            doc = ast.get_docstring(node)
            first_doc = f" # {doc.splitlines()[0]}" if doc else ""
            exports.append(f"def {node.name}({', '.join(args)}) -> {ret}{first_doc}")
        elif isinstance(node, ast.ClassDef):
            doc = ast.get_docstring(node)
            first_doc = f" # {doc.splitlines()[0]}" if doc else ""
            exports.append(f"class {node.name}{first_doc}")

    if imports:
        print("\n--- IMPORTS ---")
        for imp in imports:
            print(f"  {imp}")

    if exports:
        print("\n--- EXPORTED FUNCTIONS & CLASSES ---")
        for exp in exports:
            print(f"  {exp}")


def impact(file_path):
    full_path = os.path.join(ROOT, file_path) if not os.path.isabs(file_path) else file_path
    target_mod = os.path.splitext(os.path.basename(file_path))[0]
    dependents = []

    for dirpath, _, filenames in os.walk(ROOT):
        if ".git" in dirpath or "venv" in dirpath or "__pycache__" in dirpath:
            continue
        for fname in filenames:
            if fname.endswith(".py") and os.path.join(dirpath, fname) != full_path:
                py_file = os.path.join(dirpath, fname)
                try:
                    with open(py_file, encoding="utf-8") as f:
                        content = f.read()
                    if target_mod in content:
                        dependents.append(_rel(py_file))
                except Exception:
                    pass

    print(f"=== DOWNSTREAM IMPACT ANALYSIS FOR {_rel(full_path)} ===")
    if not dependents:
        print("No direct internal Python importers found.")
    else:
        print(f"Found {len(dependents)} dependent file(s) mentioning this module:")
        for dep in dependents:
            print(f"  - {dep}")


def syntax_check(file_path):
    full_path = os.path.join(ROOT, file_path) if not os.path.isabs(file_path) else file_path
    if not os.path.exists(full_path):
        print(f"analyze error: file not found: {file_path}")
        sys.exit(1)

    try:
        with open(full_path, encoding="utf-8") as f:
            ast.parse(f.read(), filename=full_path)
        print(f"analyze syntax-check: PASS ({_rel(full_path)} is syntactically valid Python)")
    except SyntaxError as e:
        print(f"analyze syntax-check: FAIL (SyntaxError at line {e.lineno}: {e.msg})", file=sys.stderr)
        sys.exit(1)


def validate_docs():
    constitution_path = os.path.join(ROOT, "CONSTITUTION.md")
    agents_path = os.path.join(ROOT, "AGENTS.md")
    errors = []

    if not os.path.exists(constitution_path):
        errors.append("Missing CONSTITUTION.md in project root")
    if not os.path.exists(agents_path):
        errors.append("Missing AGENTS.md in project root")
    else:
        with open(agents_path, encoding="utf-8") as f:
            content = f.read()

        arch_map_match = re.search(r"## Architecture map.*?(?=\n## |\Z)", content, re.DOTALL)
        map_text = arch_map_match.group(0) if arch_map_match else content

        matches = re.findall(r"`([^`]+\/AGENTS\.md|CONSTITUTION\.md)`", map_text)
        count = 0
        for target_rel in matches:
            if "<" in target_rel or ">" in target_rel:
                continue
            count += 1
            full_path = os.path.join(ROOT, target_rel.replace("/", os.sep))
            if not os.path.exists(full_path):
                errors.append(f"Stale/missing path in AGENTS.md architecture map: {target_rel}")

        if not errors:
            print(f"analyze: Docs validation passed ({count} architecture map reference(s) verified)")
            return

    for err in errors:
        print(f"analyze error: {err}", file=sys.stderr)
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print("usage: python tools/analyze.py <outline|context|impact|syntax-check|validate-docs> [args]")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "outline" and len(sys.argv) > 2:
        outline(sys.argv[2])
    elif cmd == "context" and len(sys.argv) > 2:
        context(sys.argv[2])
    elif cmd == "impact" and len(sys.argv) > 2:
        impact(sys.argv[2])
    elif cmd == "syntax-check" and len(sys.argv) > 2:
        syntax_check(sys.argv[2])
    elif cmd == "validate-docs":
        validate_docs()
    else:
        print("usage: python tools/analyze.py <outline|context|impact|syntax-check|validate-docs> [args]")
        sys.exit(1)


if __name__ == "__main__":
    main()

# pi-check Stack Compatibility Verification

## Date: 2026-09-02

## Objective
Verify pi-check compatibility with FastAPI (Python) and Next.js (TypeScript/React) stacks.

## Architecture Analysis

### Current Implementation

pi-check is a **generic checker runner** with NO framework-specific hardcoding:

1. **Configuration-driven** (`.pi/checks.json`):
   - `extensions`: Array of file extensions (e.g., `[".py", ".ts", ".tsx"]`)
   - `command`: Arbitrary shell command
   - `cwd`: Working directory
   - `timeoutMs`, `maxBuffer`: Resource limits

2. **File trigger mechanism**:
   - Watches `tool_result` events for file writes
   - Matches file extension against checker's `extensions` array
   - Marks checker "dirty" when matched
   - Runs dirty checkers at turn end

3. **Trust gate**:
   - Requires `ctx.isProjectTrusted()` before execution
   - Untrusted projects: skips checks with warning

4. **Single-flight execution**:
   - One execution per checker at a time
   - Coalesced rerun for additional dirty signals during execution

### Framework Independence

**NO hardcoded assumptions** for:
- Vue, React, Angular, Svelte
- Python, JavaScript, TypeScript, Go, Rust
- pytest, vitest, jest, rspec
- Any specific linter or type checker

**Runtime behavior**:
- `matchesExtension(filePath, extensions)` — pure string matching
- Command execution via `spawn()` — shell-agnostic
- Output capture — framework-agnostic

## FastAPI + Next.js Compatibility

### FastAPI (Python)

**File extensions**: `.py`

**Example checker config**:

```json
{
  "name": "ruff",
  "enabled": true,
  "extensions": [".py"],
  "cwd": "backend",
  "command": "ruff check .",
  "timeoutMs": 30000,
  "maxBuffer": 512000
}
```

**Supported commands**:
- `ruff check`
- `ruff format --check`
- `mypy .`
- `pyright`
- `pytest` (slower, better as manual)

### Next.js 14 (TypeScript/React)

**File extensions**: `.ts`, `.tsx`, `.js`, `.jsx`

**Example checker config**:

```json
{
  "name": "eslint",
  "enabled": true,
  "extensions": [".ts", ".tsx", ".js", ".jsx"],
  "cwd": "frontend",
  "command": "npm run lint",
  "timeoutMs": 45000,
  "maxBuffer": 512000
}
```

**Supported commands**:
- `eslint .`
- `tsc --noEmit`
- `next lint`
- `prettier --check .`

### Recommended Policy

**Fast feedback (auto-run at turn end)**:
- `ruff check` (Python linting)
- `eslint` (TypeScript/React linting)

**Medium (manual or selective)**:
- `tsc --noEmit` (type checking - can be slow on large codebases)
- `mypy` (Python type checking)

**Slow (manual/gate only)**:
- `pytest` (test suite)
- `next build` (full build verification)

## Verification Result

**Status**: ✅ PASS

**pi-check runtime**: NO CODE CHANGES REQUIRED

**Compatibility**:
- Python (.py): ✅ Supported
- TypeScript (.ts): ✅ Supported
- React (.tsx): ✅ Supported
- JavaScript (.js, .jsx): ✅ Supported

**Trust model**: ✅ Unchanged (project-level trust gate enforced)

**Security**: ✅ Unchanged (arbitrary commands require project trust)

**Single-flight behavior**: ✅ Unchanged

## Summary

pi-check is **already fully compatible** with FastAPI + Next.js stacks. The generic architecture supports arbitrary file extensions and commands. No runtime changes needed.

Projects configure checkers via `.pi/checks.json` with their specific tools (ruff, eslint, tsc, etc.). pi-check orchestrates execution without framework knowledge.

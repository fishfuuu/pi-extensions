# Worker Model Selection — Seam Audit (archived)

> **Archive note** — added 2026-09-14, when this file was moved out of the repository root.
> Everything below the horizontal rule is the original document, **unedited**.
>
> This audit was written against `7272966` and concluded
> `AUTOMATIC_INTEGRATION_SEAM = BLOCKED` / `READY_TO_COMMIT = NO`.
> That verdict was correct at the time. It is now **superseded**.
>
> ### What changed
>
> - **Phase 1 (upstream) succeeded.** `@quintinshaw/pi-dynamic-workflows` 3.11.0 ships the
>   seam this document asked for as "Option A": `src/pre-spawn-model.ts` exposes
>   `setPreSpawnModelResolver()`, stored on `globalThis` under
>   `Symbol.for("@quintinshaw/pi-dynamic-workflows.preSpawnModelResolver")`, with the
>   `unchanged | use | reject` decision shape.
> - **Phase 3 (integration) landed** in `d561d3e` (`pi-worker-selector`). It registers one
>   process-wide resolver through that slot.
> - **BLOCKER 1 is closed.** The `select_worker_model` Pi tool was *deleted*. Routing is no
>   longer LLM-conventional, so it cannot be bypassed by the Parent forgetting a tool call —
>   which was the original objection to the tool-based design.
> - A `reject` decision raises `MODEL_SPAWN_REJECTED` and, by construction in
>   `applyPreSpawnModel()`, never falls back to the session/Parent model.
>
> ### Still standing (not obsolete)
>
> - **BLOCKER 3 / quota pool identity V1** — one logical account per provider. `ollama`
>   and `ollama2` are the deliberate workaround for running two accounts.
> - The rollback properties and the "no DW modification" guarantee still hold.
> - The **Phase 4** enhancement list was never implemented.
>
> ### Known gap carried forward
>
> DW's resolver precedence is per-run `AgentRunOptions.preSpawnModel` > instance
> `WorkflowAgentOptions.preSpawnModel` > process `setPreSpawnModelResolver()`. The selector
> registers at the *process* level, i.e. the lowest precedence, so a workflow script that
> passes its own per-run resolver overrides the policy. `extensions/pi-worker-selector/README.md`
> does not currently document this.

---

# CORRECTION REPORT — Automatic Worker Model Selection

**Date**: 2026-01-02  
**Repository**: E:\pi-extensions  
**Branch**: main  
**HEAD**: 727296633d1ea3c1e72b2a1cff1e0b2ff79bebf4

---

## EXECUTIVE SUMMARY

The implementation of `select_worker_model` tool and quota snapshot infrastructure is **correct and fully tested** (133/133 PASS). However, **the automatic integration seam does not exist** in the current DW architecture. The approved Plan Review v2 seam was based on an incorrect assumption about DW APIs.

**AUTOMATIC_INTEGRATION_SEAM = BLOCKED**

The current implementation requires LLM-conventional behavior (parent "remembers" to call `select_worker_model`, then manually passes the result). This does NOT satisfy the frozen requirement:

> "Parent initiates a normal/tier worker → worker model selection automatically and deterministically runs → quota eligibility cannot be bypassed by the Parent forgetting a tool call."

**READY_TO_COMMIT = NO**  
**INTEGRATION_SEAM_BLOCKED**

---

## BLOCKER 1 — Selection is currently optional

### Audit findings

**DW sandbox context (exhaustive)**:
```javascript
const context = vm.createContext({
  ...projectGlobals, // assembled from WORKFLOW_CAPABILITY_CONTRACT
  // VM realm built-ins (Object, Array, JSON, Math, Date, Promise, Set, Map, etc.)
});
```

**Injected globals** (from `WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings`):
- `agent`, `parallel`, `pipeline`, `workflow`, `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`, `checkpoint`, `log`, `phase`, `args`, `cwd`, `process`, `budget`, `console`

**NO `runs` object. NO `runs.run()` API.**

The approved Plan Review v2 referenced `runs.run({ model })` as the seam. This API does not exist in DW. The intent was likely: parent passes `args.workerModel` → script uses `agent(prompt, { model: args.workerModel })`. This is LLM-conventional.

**Model resolution chain** (from `workflow.js` + `agent.ts`):
1. Workflow script calls `agent(prompt, { model, tier, ... })`
2. DW runtime calls `agentRunner.run(prompt, { model: modelSpec, tier, ... })` where `modelSpec = explicitModel ?? (tier ? undefined : resolveModelForPhase(phase, routing))`
3. Inside `WorkflowAgent.runTurn()`: `const modelSpec = resolveAgentModelSpec(options, this.mainModel, () => this.loadTierConfig(), ...)`
4. Precedence: `options.model` → tier → medium tier → session default
5. Resolved model passed to `createAgentSession({ model: resolvedModel, ... })`

**No hooks/interceptors found**:
- No `preSpawnModel` / `onBeforeRun` / `middleware` in `WorkflowRunOptions` or `AgentRunOptions`
- `WorkflowManagerOptions.agent?: Pick<WorkflowAgent, "run">` exists but is documented as "Inject a custom agent runner (tests)" — test-only escape hatch
- `extensions/workflow.ts` `buildManagerOptions()` does NOT include `agent` — injection point inaccessible without modifying installed DW code

**Evidence from runtime canary**:

When instructed to "run workflow with tier=small and report model", the parent LLM:
1. Called `select_worker_model(requirement='small')` → returned `ollama/deepseek-v4-flash:0731`
2. Then called `workflow` tool with script `agent(..., { tier: 'small' })`
3. The selector result was NOT used — DW's own tier routing picked the model
4. Both happened to agree (deepseek), but this is coincidental

This demonstrates BLOCKER 1: the selector is NOT in the automatic dispatch path; it requires LLM-conventional adherence.

### AUTOMATIC_INTEGRATION_SEAM = BLOCKED

**Current integration** (LLM-conventional):
```
Parent LLM
  → calls select_worker_model Pi tool (if remembered)
  → receives concrete model
  → manually passes to workflow args: { workerModel: "xai/grok-4.6" }
  → script uses agent(prompt, { model: args.workerModel })
```

**Correctness depends on**:
- Parent remembering to call `select_worker_model`
- Prompt instructions
- LLM tool-call ordering
- Script author using `args.workerModel`

**Quota bypass**: Parent calls `agent(prompt, { tier: 'big' })` without calling selector first. Tier routing uses whatever model is configured for `big`, ignoring quota eligibility.

### Two durable options

**Option A: Upstream contribution to DW (recommended)**

Add `preSpawnModel?: (options: AgentRunOptions) => Promise<string | undefined>` hook to `WorkflowRunOptions`:

```typescript
export interface WorkflowRunOptions {
  // ... existing options
  /** Called before each agent spawn to resolve model. Overrides tier/phase routing. */
  preSpawnModel?: (options: AgentRunOptions) => Promise<string | undefined>;
}
```

Implementation in `workflow.js` `agentImpl()`:
```javascript
let modelSpec = explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
if (!explicitModel && options.preSpawnModel) {
  const preResolved = await options.preSpawnModel({
    tier: agentOptions.tier,
    model: modelSpec,
    label: agentOptions.label,
    // ... other AgentRunOptions fields
  });
  if (preResolved) modelSpec = preResolved;
}
```

Surface through `WorkflowManagerOptions` and expose via `buildManagerOptions()` in `extensions/workflow.ts`.

**Integration seam**:
```typescript
// In pi-worker-selector/index.ts or a new pi-dw-selector-integration extension
const manager = new WorkflowManager({
  ...options,
  preSpawnModel: async (opts) => {
    if (opts.model) return undefined; // explicit model, don't override
    const requirement = opts.tier ?? 'medium';
    const result = await selectWorkerModel({ requirement, ... });
    return result.outcome === 'SELECTED' ? result.model : undefined;
  },
});
```

**Pros**: Clean, non-invasive, maintainable, no fork  
**Cons**: Requires upstream PR acceptance, timeline uncertain

**Option B: Minimal maintained fork**

Fork `@quintinshaw/pi-dynamic-workflows`, add the `preSpawnModel` hook, publish as `@<org>/pi-dynamic-workflows-quota-aware`.

**Pros**: Immediate control  
**Cons**: Maintenance burden, divergence risk, semver coordination

---

## BLOCKER 2 — Prove actual spawn

### Requirement vs. evidence gap

**User requirement**:
> "Codex synthetic INELIGIBLE, normal big request, xAI healthy → REAL worker session created → inspect actual worker/session model → MUST equal xai/grok-4.6"

This requires:
1. Synthetic INELIGIBLE quota for Codex (≤10% remaining)
2. Selector running automatically before spawn
3. Observing actual spawned worker model

**Actual state**:
1. BLOCKER 1 = BLOCKED → selector not in automatic path
2. Synthetic INELIGIBLE quota requires either:
   - Actually burning quota to 5% (unsafe for testing)
   - Injecting mock quota state (requires test harness, not runtime canary)
3. DW tier routing (independent of selector) CAN be observed

### What WAS tested

**DW Tier Routing Canary C**: ✅ PASS

Real DW workflow executed:
```javascript
export const meta = { name: 'spawn-canary-C', description: 'tier=small actual model' };
const r = await agent('Reply with exactly one word: done', { tier: 'small', label: 'canary-small' });
```

**Evidence from `workflow` tool JSON output**:
```json
{
  "agents": [{
    "id": 1,
    "callId": "spawn-canary-c-mtk6udfh-7ln7g0:0",
    "label": "canary-small",
    "status": "done",
    "model": "ollama/deepseek-v4-flash:0731",
    "tokens": 7519,
    "tokenUsage": {"input": 7504, "output": 15, "total": 7519}
  }]
}
```

**Confirmed**:
- Real worker session spawned (callId assigned, session persisted)
- Actual worker model: `ollama/deepseek-v4-flash:0731`
- Requested tier: `small`
- `model-tiers.json` small tier: `ollama/deepseek-v4-flash:0731`
- 7,519 tokens consumed (not a mock)

**DW tier routing works correctly.**

### Selector-integrated canaries: SEAM_BLOCKED

**Canaries A, B, D, G as specified**:
- A: Codex INELIGIBLE (5%), big, xAI healthy → worker = xai/grok-4.6
- B: xAI INELIGIBLE, Codex healthy, big → worker = openai-codex/gpt-5.6-sol
- D: All big-capable INELIGIBLE → no spawn
- G: No model/tier, parent=arbitrary → worker ≠ parent (medium tier, not parent model)

**Cannot pass**: Require the selector to run automatically before spawn. Since BLOCKER 1 = BLOCKED, these cannot be tested as specified.

**What IS proven**:
- Unit tests F1-F12 (17/17 PASS): selector logic deterministically correct with synthetic quota
- Runtime tool invocation: `select_worker_model` callable, returns correct SELECTED/STOP
- DW tier routing canary C: actual spawn with correct tier→model resolution

**Status**: SEAM_BLOCKED (not ENVIRONMENT_BLOCKED — the seam itself doesn't exist yet)

---

## BLOCKER 3 — Quota pool identity scope

### Frozen target vs. V1 implementation

**Frozen target**: provider + endpoint + auth/account identity

**V1 implementation**: `providerId` only

### Current behavior

**From `discover.ts`**:
```typescript
export function discoverQuotaTargets(registry: ModelRegistry): QuotaTarget[] {
  const seen = new Set<string>();
  for (const item of list) {
    if (seen.has(item.providerId)) continue; // dedup by providerId
    seen.add(item.providerId);
    out.push({ providerId, displayName, adapter });
  }
}
```

**Pool key**: `providerId` (e.g., `"openai-codex"`, `"xai"`, `"ollama"`)

**Dedup behavior**: First wins, silent (no warning). Multiple accounts with the same `providerId` but different `baseUrl` or auth are merged into a single pool entry.

**`origin` field**: Extracted via `originOf(baseUrl)` → `new URL(url).origin` → non-secret (e.g., `"https://api.x.ai"`). Used for adapter matching, NOT for pool keying.

### Can minimal safe identity be added?

**Yes**: `originOf(baseUrl)` returns URL origin (scheme + host + port), which is non-secret. Could use `{ providerId, origin }` as snapshot key.

**Example**:
- `xai` at `https://api.x.ai` vs `xai` at `https://proxy.example.com/xai` → distinct pools
- No credentials, tokens, or auth hashes exposed

**Decision**: Defer to Phase 2. Implementing now is premature given BLOCKER 1 blocks the whole integration.

### QUOTA_POOL_IDENTITY_V1 = ONE_LOGICAL_ACCOUNT_PER_PROVIDER

**V1 limitation** (frozen):
- Pool key: `providerId` only
- Multiple accounts per provider: merged (first wins, silent dedup)
- No baseUrl/endpoint/auth distinction

**Config/runtime behavior**:
- `seen.has(item.providerId)` → silent skip (no error, no warning)
- Not fail-reject, fail-silent (discoverable only by observing missing quota data)

**Documentation required**:
- README: V1 limitation section
- `snapshot.ts`: Comment on `QuotaSnapshot` type
- `config.ts`: Note on `workerPool` entries

**Phase 2 enhancement**: Add `origin`-keyed pool (`providerId|origin` as key), expose via config schema, add duplicate-account warning.

---

## BLOCKER 4 — Staged-state evidence

### Corrected git state

```
Repository: E:\pi-extensions
Branch: main
HEAD: 727296633d1ea3c1e72b2a1cff1e0b2ff79bebf4
Previous commit: feat(pi): add tool presets and package distribution
Origin: main == 727296633d1ea3c1e72b2a1cff1e0b2ff79bebf4 (up-to-date)

Staged files (11):
  M extensions/pi-quota/index.ts
  A extensions/pi-quota/snapshot.ts
  A extensions/pi-quota/tests/snapshot.test.mjs
  A extensions/pi-worker-selector/README.md
  A extensions/pi-worker-selector/config.ts
  A extensions/pi-worker-selector/core.ts
  A extensions/pi-worker-selector/index.ts
  A extensions/pi-worker-selector/tests/selector.test.mjs
  M package.json
  M scripts/install.ps1
  M tests/package-contract.test.mjs

Unstaged modifications: 0
Untracked files: 0

git diff --check: PASS (CRLF warnings only, not errors)
```

**State classification**:
- staged = 11 (uncommitted changes)
- unstaged = 0
- untracked = 0
- HEAD = last committed state (these changes not yet committed)

**NOT "working tree clean"** in the normal git sense. There are staged uncommitted changes.

**Previous error**: Final report claimed "working tree clean" and "all gates including staged=0 passed". This was incorrect. The correct state is: staged=11, unstaged=0, uncommitted.

---

## IMPLEMENTATION SUMMARY

### What IS complete and correct

**1. Pure selector logic** (`extensions/pi-worker-selector/core.ts`):
- `selectWorkerModel(input): SelectorResult` — pure, deterministic, fully testable
- Modes: forced/explicit (exact match + STOP on ineligible), tier (capability + quota filter + cost sort)
- Unit tests F1-F12: 17/17 PASS

**2. Quota snapshot API** (`extensions/pi-quota/snapshot.ts`):
- `fetchAllQuotaSnapshots(registry, policy)` — async, coalesced, cached
- `cardToSnapshot(card, policy)` — pure conversion
- `evaluateStatus(pct, policy)` — HEALTHY/INELIGIBLE/UNKNOWN with fail-open
- Unit tests: 19/19 PASS

**3. Pi tool registration** (`extensions/pi-worker-selector/index.ts`):
- `select_worker_model` Pi tool — callable, tested, works
- Runtime canary: tool invocation confirmed, quota fetch works, returns correct SELECTED/STOP

**4. Config schema** (`extensions/pi-worker-selector/config.ts`):
- `workerPool[]` — explicit allowlist, backward-compat tier derivation
- `quotaPolicy { thresholdPct }` — default 10%, configurable

**5. Package integration**:
- `package.json` pi.extensions updated
- `scripts/install.ps1` allowlist updated
- `tests/package-contract.test.mjs` assertions updated (5/5 PASS)
- Installer: `pi-worker-selector` installs correctly
- Native Pi package: clean isolation verified

**6. Test coverage**:
```
pi-check:              7/7 PASS
pi-quota/core:         7/7 PASS
pi-quota/snapshot:    19/19 PASS   ← NEW
pi-tool-presets:       6/6 PASS
pi-db/sql:            26/26 PASS
pi-db/project-gate:   51/51 PASS
pi-worker-selector:   17/17 PASS   ← NEW (F1-F12 + extras)
package-contract:      5/5 PASS    (was 2/2)
---
Total: 133/133 PASS
```

**7. Rollback-safe**:
- Uninstall pi-worker-selector: `rm -rf ~/.pi/agent/extensions/pi-worker-selector`
- No DW modification → no DW regression
- Config rollback: remove `workerPool`/`quotaPolicy` → selector falls back to tier derivation

### What is NOT complete

**1. Automatic integration seam**: Does not exist (BLOCKER 1)

**2. Runtime spawn canaries A/B/D/G**: Cannot run until BLOCKER 1 resolved

**3. Quota pool identity**: V1 limitation (providerId-only) frozen but not yet documented in README

**4. DW integration**: Requires upstream contribution or maintained fork

---

## READY_TO_COMMIT

**Per user requirements**:
> "READY_TO_COMMIT = YES only if: AUTOMATIC_WORKER_SELECTION = deterministic for the supported worker path"

**Actual state**: AUTOMATIC_WORKER_SELECTION = LLM-CONVENTIONAL (not deterministic)

**Verdict**: **READY_TO_COMMIT = NO**

**Reason**: **INTEGRATION_SEAM_BLOCKED**

---

## RECOMMENDED PATH FORWARD

### Phase 0: Documentation (immediate)

1. Add V1 limitation section to `extensions/pi-worker-selector/README.md`:
   - Quota pool identity = providerId-only
   - Multiple accounts per provider silently merged
   - Phase 2: origin-keyed pool enhancement

2. Add code comments to `snapshot.ts` and `config.ts` documenting the V1 pool identity scope

3. Update README integration section to clarify:
   - Current state: manual/explicit invocation via `select_worker_model` tool
   - Automatic integration: requires DW upstream contribution or fork

### Phase 1: Upstream contribution (recommended)

1. Draft PR for DW adding `preSpawnModel` hook
2. Include motivation, use case, backward-compat analysis
3. Coordinate with DW maintainer on implementation approach
4. Timeline: depends on upstream acceptance

### Phase 2: Fork (if upstream blocked)

1. Fork `@quintinshaw/pi-dynamic-workflows`
2. Add `preSpawnModel` hook (minimal diff)
3. Publish as `@<org>/pi-dynamic-workflows-quota-aware`
4. Track upstream for non-hook changes
5. Provide migration path when upstream accepts hook

### Phase 3: Integration (after seam available)

1. Create `pi-dw-selector-integration` extension (or fold into `pi-worker-selector`)
2. Inject `preSpawnModel` via `WorkflowManagerOptions`
3. Wire `select_worker_model` logic into pre-spawn hook
4. Re-run canaries A/B/D/G with automatic dispatch
5. Verify Parent quota bypass is prevented

### Phase 4: Enhancements

1. Add origin-keyed quota pool identity
2. Add duplicate-account detection warning
3. Worker continuation (preserve model for retries)
4. Cache economics (warm token cost in selection)

---

## COMMIT GATE

**Do NOT commit** until one of:
1. AUTOMATIC_INTEGRATION_SEAM resolved (upstream hook or fork available)
2. User explicitly approves partial commit (pure selector/snapshot work without integration)

**Current staged work** (11 files) is correct and tested, but does not complete the goal.

---

## FINAL STATUS

| Item | Status |
|------|--------|
| Pure selector logic | ✅ COMPLETE (17/17 PASS) |
| Quota snapshot API | ✅ COMPLETE (19/19 PASS) |
| Pi tool registration | ✅ COMPLETE (runtime verified) |
| Unit tests | ✅ PASS (133/133) |
| DW tier routing canary | ✅ PASS (actual spawn observed) |
| Automatic integration seam | ❌ BLOCKED (does not exist) |
| Selector spawn canaries A/B/D/G | ❌ SEAM_BLOCKED |
| Quota pool identity V1 docs | ❌ INCOMPLETE (needs README update) |
| READY_TO_COMMIT | ❌ NO (INTEGRATION_SEAM_BLOCKED) |

**STOP**: Do not commit. Do not push. Integration seam must be resolved first.

# pi-side-panel — vendoring notes

`/side` is a read-only side thread with its own input box: `zcode`'s `/side`
shape, built on the same machinery as `@juicesharp/rpiv-btw`'s `/btw`.

## What `vendor/` is

`vendor/` holds **byte-identical copies** of the upstream package's source, taken
from the installed copy at

```
~/.pi/agent/npm/node_modules/@juicesharp/rpiv-btw
```

It is a library here, not a fork: **nothing in `vendor/` is ever edited.** All of
our behaviour lives in `panel.ts`, `driver.ts`, and `index.ts`, which import from
it. That keeps an upstream re-sync a mechanical copy instead of a merge.

`vendor/index.ts` is copied for completeness but never imported — it registers
`/btw`, and registering a second time would collide with the real package.

## Why the fork exists

Three things upstream does not do, all implemented outside `vendor/`:

1. **A panel that stays open.** Upstream's `/btw` is one question per command: the
   overlay has no text field (only Esc / ↑ / ↓ / x) and closes when the answer
   lands. `panel.ts` embeds a pi-tui `Input` so the thread continues in place.
2. **A CJK-aware branch budget.** Upstream bounds the branch with the host's
   `estimateTokens`, which is `chars / 4`. Chinese runs close to one token per
   character, so a mostly-Chinese session is undercounted and the assembled
   prompt can exceed the window the provider enforces. Reported as
   [juicesharp/rpiv-mono#274](https://github.com/juicesharp/rpiv-mono/issues/274).
   Fix: `driver.ts` measures the branch itself and passes an explicit
   `keepBudget` (which bypasses upstream's window formula) scaled by the ratio
   between the two estimates.
3. **Context overflow that the CN endpoint actually produces.** Upstream's retry
   halves the budget and re-sends once, gated on Pi's `isContextOverflow`, whose
   `OVERFLOW_PATTERNS` match api.z.ai's `Prompt too long` but not
   open.bigmodel.cn's `Prompt exceeds max length` (both are Z.AI code 1261).
   Reported as
   [earendil-works/pi#10208](https://github.com/earendil-works/pi/issues/10208).
   Fix: `driver.ts` adds that wording to its own predicate before deciding to
   retry.

Both upstream reports are open. When either lands, the matching fix here can be
dropped — they are independent of the panel.

## Shared state, and the one coupling worth knowing

History lives in the upstream package's process-scoped store
(`globalThis[Symbol.for("rpiv-btw")]`, reachable through the exported
`BTW_STATE_KEY`), which is how one side thread per session is shared between
`/side` and `/btw`. `driver.ts` reads and writes that store directly, because
`buildBtwMessages` always reads the upstream history and the push helper is not
exported.

The branch-snapshot cache in that same store is filled by upstream's
`message_end` hook, registered by the real `rpiv-btw` package. This extension
does not register a second copy (that would duplicate work on every turn). If
`rpiv-btw` is ever removed, `/side` still works: `buildBtwMessages` falls back to
reading the branch live instead of the cache, just less efficiently.

## Re-syncing after an upstream release

```powershell
$src = "$env:USERPROFILE\.pi\agent\npm\node_modules\@juicesharp\rpiv-btw"
$dst = "E:\pi-extensions\extensions\pi-side-panel\vendor"
Copy-Item "$src\btw.ts","$src\btw-budget.ts","$src\btw-messages.ts","$src\btw-ui.ts","$src\pi-compat.ts","$src\index.ts" $dst -Force
Copy-Item "$src\prompts" $dst -Recurse -Force
```

Then re-check the hashes below, re-read upstream's changelog for anything the
local behaviours above should follow, and re-run the Pi Web verification (see the
extension's README).

## Vendored revisions

`@juicesharp/rpiv-btw@2.11.0` — sha256, taken 2026-09-30:

```
btw.ts                       be8d55a3d6159aca43f777c818a2942779bd82f8b6893fdd11837600cbc8eaef
btw-budget.ts                7ae97043b518ec960c30921cf9a109b16dfed332a67a46e35644f18dcaec27fe
btw-messages.ts              4dfe11226bce24d9bbfc65bedf421ce6e6d5b231469aff440cf5df787523edbb
btw-ui.ts                    a46731d739600cb07fcbf3c3314a9fd4cfcb9734a661093e5bf9f0289a54cb1c
pi-compat.ts                 330ea5999a5dc3dd8e07fcfcec056c8ea6936e8e4c621f9c56c30785f731f014
index.ts                     65a9047fc9e9f2b5087a5dd7b4f881dc62defab01988c4832dbf5d6549ec39f8
prompts/btw-system.txt       afed7e1a298d7ba9489bce8a107b1fc9319bf8f7c314008a7ab30b9a83fe92d9
```

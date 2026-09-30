# pi-side-panel

`/side` — a read-only side thread that lives in a panel you can keep chatting in.

Pi's built-in `/btw` (from `@juicesharp/rpiv-btw`) answers one side question per
command: its overlay has no text field, so a follow-up means leaving the panel and
typing `/btw` again. This extension keeps the panel open with its own input box,
in the shape `zcode` calls a side conversation.

## Usage

```
/side                       open the panel and type
/side why did we drop SSE?  open the panel and ask straight away
```

Inside the panel:

| Key | Action |
| --- | --- |
| `Enter` | ask the typed question, appending to the side thread |
| `↑` / `↓` | scroll when the thread is taller than the panel |
| `Esc` | close the panel (aborts an in-flight question) |

## What it guarantees

- **Read-only.** The request goes out with `tools: []`, so a side question cannot
  edit a file or run a command. The system prompt says the same, and the answer is
  plain text.
- **Never in the transcript.** The answer is drawn in the overlay; it is not an
  agent message and nothing is written to disk.
- **No effect on the main session.** `Esc` aborts only the side call.
- **It already knows the work.** The side call is handed a read-only clone of the
  context Pi itself sends — the newest compaction summary plus everything after it
  — plus this session's earlier side questions. It deliberately does not clone the
  whole pre-compaction branch: on a heavily compacted session that branch can be
  larger than the model's window (1204597 tokens against a 1048576 window, while
  the compacted context was ~9% of it), which made every side question fail.

History is process-scoped: it survives `/new`, `/fork`, `/reload`, `/resume`, and
is gone when Pi exits. It is shared with `/btw`, which is still free to use.

## Relationship to `@juicesharp/rpiv-btw`

The turn machinery is that package's, vendored under `vendor/` and never edited.
See [VENDOR.md](VENDOR.md) for the pinned revision, the file hashes, the re-sync
command, and the local behaviours this extension adds outside `vendor/`
(a panel that stays open and holds keyboard focus, markdown-rendered answers, a
clickable `[ x close ]` target, a CJK-aware branch budget, a side-thread snapshot
taken from the compacted context instead of the whole branch, and
context-overflow detection for Z.AI's CN endpoint).

`rpiv-btw` itself stays installed and keeps serving `/btw`. Only `/side` comes
from here.

## Install

```powershell
.\scripts\install.ps1 pi-side-panel          # first install
.\scripts\install.ps1 pi-side-panel -Update  # re-deploy after edits
```

Then `/reload` (or restart Pi). Not part of `install.ps1 all`; it is opt-in.

---
description: "Manage MyDot Spaces, parallel local jobs, scoped Markdown memory and versioned current-file edits in DSH Web."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-mydot

English | [中文](README.zh.md)

## Summary

Create a Space, choose reference files and an execution Workspace, and continue talking while two local child Sessions work independently. Send text to an exact child, stop one child, and open deliverables through their source conversation. Edit bounded UTF-8 files and Markdown memory with version checks. Enable human requests to park one branch, answer from the pending list, and return to its original Session. This opt-in experimental composition adds no task database and enables no desktop automation or recurring schedule by default.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add this row to a Web Host composition whose resolver can load this package; keep the existing Session Controller, Subagent Spawn/Fork, filesystem and configured storage-domain services. The browser module is `@deepseek-ai/dsh-experimental-mydot/client`; it mounts its generated Remote contribution and effect-owned sidebar and conversation slots. No standard profile is changed.

The `/types` entry provides declarations through `import type`; runtime consumers use the Host or `/client` entry.

```yaml
- name: '@deepseek-ai/dsh-experimental-mydot'
```

The [configuration catalog](../../../docs/config-catalog.md) owns accepted fields. `memoryDirectory` defaults to the Host user’s `~/MyDot`; personal memory uses `MEMORY.md`, and Space memory uses `spaces/<SpaceId>/MEMORY.md`. `maxTextBytes` defaults to 262144 and `summaryCharacters` to 240. `desktopTools` and `captureTools` default to empty arrays.

Direct memory edits keep the filesystem provider’s deployment mode and use the configured memory directory as their write scope. Document edits use the original conversation’s recorded mode and execution directory, including after Host restart. Read-only mode still refuses writes, and the provider rechecks canonical containment before publication; a symlink escaping the permitted root gains no write access. These editor operations do not grant broader file access to agent tools.

Use the MyDot sidebar to create or edit Space metadata, list reference paths, choose an existing Workspace ID, and start a fresh conversation. Archiving preserves files, conversations and existing associations. A conversation has one Space association; changing Space metadata never rewrites an existing Session’s directory. The conversation dock starts two local Spawn jobs, selects their exact IDs, and offers Steer or Queue. The normal conversation composer remains available for attachments and ordinary conversation.

Acceptance receipts describe inbox admission. Stop acceptance is separate from observed inactivity and retains queued input. A cold parent must be reopened before sending to its child. Unconfirmed requests and initial job IDs remain in the viewing store; reconnect never automatically resends them. Job summaries quote logged assistant output and do not verify its correctness.

Child declarations are delivered to the parent’s durable inbox with their original Session and current paths. Lists reconstruct declarations from source logs; moving a file leaves a missing-file entry. Preview first opens the source conversation, then uses its existing right-sidebar file viewer. The text editor retains drafts on stale saves and displays the current conflicting text; merge and save, or discard and reload. Continue records the saved path and version in the source conversation and asks the next turn to reread it.

Desktop coordination only applies to tool names explicitly listed in `desktopTools`. Include every observation, action and verification tool for the same execution world; `captureTools` must be a subset containing only read-only image captures. Operations serialize under one Session owner. Handoff closes admission and waits for admitted bodies; human ownership cannot resume until a successful image capture completes after handoff. Open the owner conversation to inspect that screen and its timestamp. The capture must be requested through the owner’s existing conversation; this package starts no tool by itself. Release a quiescent agent owner to allow another waiting job. Unconfigured tools and external desktop controllers are outside this coordination.

The existing Schedule page pauses or resumes future deliveries under the same ID. Already delivered requests and active turns remain unchanged; delivery receipts do not certify successful output. See the [Schedule reference](../../../docs/subsystems/schedule.md).

Human requests require `humanHandoffEnabled: true` and durable Session persistence. The model prepares a reason, evidence link, exact source/base version, owner response choices and a next action; the tool ends that branch without keeping a model request open. Other branches continue. The MyDot pending list retains drafts and distinguishes a saved answer, delivery, consumption by the original Session, and an explicitly recorded outcome. Opening `/?humanRequest=<requestId>` selects a card without submitting an answer. Unknown, deferred, rejected and needs-material responses stop the branch. Cancel retires its request; a new explicit owner message can supersede a stopped request without replaying its answer. An answer grants no external-action authority.

For drawing review, configure `humanHandoffSocketPath` in an existing canonical owner-private directory and `humanHandoffSurveyOrigin` as a fixed loopback HTTP origin. Set a measured positive `humanHandoffTimeoutMs`; the optional listener has no default deadline. The drawing server posts a persisted result reference to `POST /human-requests/<requestId>/answers`; MyDot independently reads the fixed server's authoritative handoff record and requires exact source/base association and current survey/planning heads. Startup recovers a saved result whose callback was lost. A temporary verification failure retains the pending request; use its recovery button after the server is available. The request stores references, while drawing edits remain in the drawing application. Independent-reference review does not display model answer options.

MyDot flushes the answer before acknowledging it and flushes a delivery marker before waking the original Session. A direct child uses its durable root parent's request ledger and the existing child continuation API. Changed, paused, completed or exhausted goals refuse continuation; consumed rounds remain consumed. After uncertain delivery, MyDot checks the original Session's actual input before reporting consumption. An unconfirmed external outcome stays stopped and is never automatically replayed. Successful outcome recording requires an existing result artifact; it does not establish the artifact's quality or human acceptance.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `mydot` storage domain owns small Space records and the authoritative Session-to-Space association. Each record commits separately; there is no cross-record transaction. Job status, request deduplication and artifacts derive from existing Session catalogs, inbox splices and deliverable events. The Remote stream uses the existing WebSocket transport and aborts on disposal. Unreadable sources retain other results and show diagnostics. Reload closes the domain handle and removes listeners before another instance opens it.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Host composition, recorded context and Remote operations |
| [`src/spaces.ts`](src/spaces.ts) | Serialized metadata and immutable associations |
| [`src/control.ts`](src/control.ts) | Per-child admission and durable request deduplication |
| [`src/files.ts`](src/files.ts) | Consistent reads and version-guarded edits |
| [`src/desktop.ts`](src/desktop.ts) | Software ownership and handoff admission |
| [`src/human-handoff.ts`](src/human-handoff.ts) | Durable owner requests, answer admission and recovery |
| [`src/client/mount.ts`](src/client/mount.ts) | Shared subscription, navigation and Slot registration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace](../../../docs/subsystems/workspace.md): canonical execution directories.
- [Subagent](../../subagent/subagent/README.md): local continuation and lifecycle.
- [Filesystem](../../fs/fs/README.md): optimistic write guarantees.

<a id="model-experience"></a>
## Model Experience

### Space and scoped memory

#### What the model sees

Each linked Session receives a logged `mydot` snapshot containing Space ID, name, purpose, instructions, reference paths, personal `MEMORY.md` and that Space’s `MEMORY.md`, including source paths and observed versions. Other Spaces’ history and memory are excluded. A local child starts with `MyDot job request: <JSON>` naming the exact parent, request identity, label and request. Parent file notices use `Child-declared current files; their contents are not verified.` followed by source coordinates.

#### Token effect

Space and selected memory text add input tokens on each step. Their byte bounds are configured; child requests and file notices remain in durable conversation history until existing compaction changes the request.

#### KV Cache effect

Snapshots append after existing conversation input. Editing Space instructions or memory changes the next snapshot and can reduce prefix reuse from that point; unchanged earlier conversation entries remain reusable.

### Human requests

#### What the model sees

`prepare_human_request` returns the persisted request ID and pending state, then ends only its branch. The continuation contains the saved question, exact answer/result references and prepared next action, with an explicit statement that the response grants no broader external-action permission. `record_human_request_outcome` records artifact evidence or a concrete failed/unknown stopping reason only after that Session consumes the answer.

#### Token effect

Waiting starts no model or long-lived tool call. Preparation, the accepted answer and any explicit outcome occupy ordinary logged tool/input tokens; all existing model and goal limits still apply.

#### KV Cache effect

The answer appends to its original Session. It does not rebuild a fresh child or rewrite earlier conversation text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The package operates on current local Session and file capabilities:

- Text editing supports bounded UTF-8 Markdown/text, not full Office editing or immutable file versions.
- Memory is explicit editable Markdown; external embeddings and cross-Space history injection are not required.
- Desktop ownership is per Host instance and only gates configured tools. Real human handoff and phone keyboard, photo and navigation acceptance require device testing.
- External one-shot executions have no continuation controls. Runtime completion and assistant summaries never certify correct deliverables.
- Human handoff supports a root or its direct local child; nested children and children with an explicit per-activation token cap refuse preparation because the current cold-child API cannot preserve that cap. The owner can prepare on the root instead.
- The first drawing workflow binds survey and planning to the same case. Notifications, global Codex app-server integration, PC takeover and additional business widgets remain unconfigured; revisit them only for a concrete supported consumer.
- Unix callbacks require POSIX ownership and a measured deployment deadline. Arbitrary external effects cannot be delivered exactly once; uncertain delivery requires inspection or new explicit owner work. No iPhone or independent-human acceptance follows from automated fixtures.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

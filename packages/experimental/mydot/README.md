---
description: "Manage MyDot Spaces, parallel local jobs, scoped Markdown memory and versioned current-file edits in DSH Web."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-mydot

English | [中文](README.zh.md)

## Summary

Create a Space, choose reference files and an execution Workspace, and continue talking while two local child Sessions work independently. Send steering or queued text to an exact child, stop one child, and open current deliverables through their source conversation. Edit bounded UTF-8 files and personal or Space Markdown memory with version checks. This opt-in experimental composition adds no task database and enables no desktop automation or recurring schedule by default.

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

### Observe an existing CI result

`verificationChecks` defaults to `[]`, which disables evidence controls and external reads. To enable a condition, configure its stable `id`, GitHub `repository` in `owner/name` form, `workflowPath`, the exact reviewed workflow Git blob `workflowFileSha`, an exact `jobName`, and a user-facing `description`. Review that workflow's job semantics and confirm that its checkout tests the event commit without a `ref` override. The first provider accepts `push` and `merge_group` runs with that exact commit and workflow blob; it does not infer a tested commit from a `pull_request` run. Updating a workflow requires reviewing and updating its configured blob SHA.

In a child job's verification controls, select the original user request, a configured condition and the full 40-character commit SHA. Then enter an existing GitHub Actions run ID and fetch its evidence. The Host uses its authenticated `gh` executable with read-only GitHub API requests; selecting a target alone performs no external read. Completed children and history after restart use the existing persistence writer for short record transactions, without activating a Session or Agent. A conflicting or unavailable writer leaves the operation unconfirmed and can be retried. No model turn, workflow rerun, polling loop or automatic correction starts from these controls.

The card keeps execution activity separate from verification. An unobserved condition remains unobserved; only the selected job's completed `success` establishes a pass. `failure` and `timed_out` establish failure. Missing or ambiguous jobs, skipped or neutral conclusions, unfinished runs, unsupported events, changed workflow source and unavailable reads remain unavailable. An overall successful workflow does not make its skipped job pass. Evidence records the exact request, commit, condition revision, run attempt, source event, job link and observation time. The reader rechecks the run after collecting its jobs and rejects an attempt that changed during the read.

Selecting another request or commit, replacing the selected request's message, or changing a configured condition prevents previous evidence from satisfying the current selection. Old observations remain visible with their original target; ordinary additional conversation does not rewrite an explicitly selected request. Refresh is explicit and records what GitHub returned at that time; saved evidence does not certify the result of a later rerun, mutable local files, deployment or user acceptance. Read failures remain visible and can be retried without inventing a successful result. `verificationTimeoutMs` defaults to 30000 for the whole read, and `verificationOutputBytes` defaults to 1048576 per response; truncated responses never establish success.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `mydot` storage domain owns small Space records and the authoritative Session-to-Space association. Each record commits separately; there is no cross-record transaction. Job status, request deduplication and artifacts derive from existing Session catalogs, inbox splices and deliverable events. The Remote stream uses the existing WebSocket transport and aborts on disposal. Unreadable sources retain other results and show diagnostics. Reload closes the domain handle and removes listeners before another instance opens it.

CI targets and observations use versioned `plugin:mydot/verification-*` records in the child's existing Session log. The registered `mydotEvidence` projection validates records and reconstructs current and historical bindings without a second work database. Forked parent records cannot satisfy a child's request. The separate `mydotEvidence` Remote service owns explicit reads and waits for the existing Session writer's flush before acknowledging a saved result. Live views acknowledge the existing Session writer's checkpoint before exposing newer evidence; failed checkpoints remain unavailable. A small in-memory cursor caches only acknowledged prefixes for the exact live Session, and plugin reload checkpoints them again. Cold views use the persisted projection and checkpoint an unacknowledged source revision through a short persistence write handle; they never publish a live Session. Cold writes reuse that same handle ownership across validation, append and flush, and release it before any GitHub read. Its subprocess calls share Host cancellation and output bounds; credentials and command stderr are not included in evidence.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Host composition, recorded context and Remote operations |
| [`src/spaces.ts`](src/spaces.ts) | Serialized metadata and immutable associations |
| [`src/control.ts`](src/control.ts) | Per-child admission and durable request deduplication |
| [`src/files.ts`](src/files.ts) | Consistent reads and version-guarded edits |
| [`src/desktop.ts`](src/desktop.ts) | Software ownership and handoff admission |
| [`src/verification.ts`](src/verification.ts) | Explicit CI reads and durable evidence admission |
| [`src/verification-records.ts`](src/verification-records.ts) | Validated Session records, projection and target currentness |
| [`src/verification-github.ts`](src/verification-github.ts) | Exact GitHub workflow attempt and job matching |
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

Each linked Session receives a logged `mydot` snapshot containing Space ID, name, purpose, instructions, reference paths, personal `MEMORY.md` and that Space’s `MEMORY.md`, including source paths and observed versions. Other Spaces’ history and memory are excluded. A local child starts with `MyDot job request: <JSON>` naming the exact parent, request identity, label and request. Parent file notices use `Child-declared current files; their contents are not verified.` followed by source coordinates. CI observations appear in MyDot's user interface and persisted plugin records. They add no model prompt, tool or automatic continuation; assistant completion text cannot submit or replace CI conclusions.

#### Token effect

Space and selected memory text add input tokens on each step. Their byte bounds are configured; child requests and file notices remain in durable conversation history until existing compaction changes the request.

#### KV Cache effect

Snapshots append after existing conversation input. Editing Space instructions or memory changes the next snapshot and can reduce prefix reuse from that point; unchanged earlier conversation entries remain reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The package operates on current local Session and file capabilities:

- Text editing supports bounded UTF-8 Markdown/text, not full Office editing or immutable file versions.
- Memory is explicit editable Markdown; external embeddings and cross-Space history injection are not required.
- Desktop ownership is per Host instance and only gates configured tools. Real human handoff and phone keyboard, photo and navigation acceptance require device testing.
- External one-shot executions have no continuation controls. Runtime completion and assistant summaries never certify correct deliverables.
- CI evidence currently supports explicitly reviewed GitHub `push` and `merge_group` workflows with one exact job name. Pull-request merge mapping, inferred criteria, external outcome providers and automatic experiments are deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

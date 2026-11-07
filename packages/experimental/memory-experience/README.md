---
description: "Recall source-referenced execution experiences within the current host project and directory."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-memory-experience

English | [中文](README.zh.md)

## Summary

Reuse concrete execution experiences during repeated work in the same host project and working directory. Save admitted requests and original tool observations, then recall a bounded selection in the current runtime context. Inspect and retire individual records without a model request. This experimental feature makes no auxiliary model requests and stays off unless a profile mounts it.

## Table of Contents

- [Use this package](#use-this-package)
- [Stored evidence](#stored-evidence)
- [Recall and recovery](#recall-and-recovery)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the default-export `ExperienceMemory` service in an explicitly opted-in profile with Session persistence, Session Query, storage domains, System Prompt, Working Directory, Token Meter, and Commands. Configure a durable backend for the `memory_experience` storage domain. [Profiles and patches](../../../docs/architecture.md#profiles-and-bundles) own installation and composition.

`mode: retrieval` enables automatic capture and recall. `mode: off` disables automatic Session-history reads, capture, recovery, and prompt contributions; inspection and retirement remain available. A profile reload applies configuration changes. The default contribution budget is 3,000 estimated tokens and at most two distinct prior work groups. `maxRecordChars`, `maxObservations`, `maxRecoverSessions`, and `maxCandidates` bound retained records and local processing; reaching a recovery or candidate limit is visible in status and logs.

Use `/memory-experience status`, `/memory-experience list`, `/memory-experience inspect <episode-id>`, or `/memory-experience retire <episode-id>` without invoking a model. Inspection and retirement authorize the exact current host directory scope. Retirement retains a permanent tombstone, removes affected current recall, and prevents recovery from recreating the record.

## Stored evidence

Each episode identifies one locally born Session turn and its immutable start/end sequence range. The record includes the admitted request and original tool operations, results, errors, and an observed revision when a tool reports one. Every excerpt carries its source event sequence; rendering includes the Session id. Assistant prose, reasoning, injected context, inherited fork events, known memory echoes, Session-query output, and sensitive file reads do not become new tool evidence.

Task completion remains `unknown` for a `completed` turn or completed goal. An explicit error ending is `failed`; an explicit abort is `aborted`. Synthetic interrupted/forked closers are excluded. A successful tool verification is a source observation, not proof that the whole task succeeded. Known environment credentials, credential assignments, Bearer tokens, and private PEM keys are redacted before the complete serialized episode is bounded.

Capture awaits `ctx.sessions.flush(session)` before storing an episode and refuses a source with no durability participant. The shipping composition must supply the actual Session writer. Domain writes complete before the record becomes readable. Capture, recovery, selection, and retirement share an owned serialized queue; the next pre-step and plugin disposal drain that queue. Explicit consumers can await `ctx.experienceMemory.flush()` after a turn. The plugin does not register a Session-flush listener, because doing so would count its own consumer as a durability participant.

## Recall and recovery

Scope is the normalized pair of the immutable Session project directory and its effective host working directory. Missing project identity disables automatic memory. Model text never supplies scope. A directory change prevents an older selection from being rendered in the new scope. Capture excludes an entire turn if it visits another directory, including a return to its starting directory. Recovery filters persisted Sessions by the original project directory, reconciles ended local turns, and respects the configured Session bound. No source file, embedding index, or network search is used for retrieval.

Normal root requests group by Session and turn. Goal continuation rounds share their stable goal identity. A child marked as a subagent must resolve its root task through its immutable parent id and the parent's durable subagent catalog; missing attribution fails closed. When a parent adopts a goal, saved child episodes move to that goal group while retaining their observations, source references, and retirement tombstones. Recovery reconciles the same attribution without adding records. Recall excludes the current group and chooses at most one episode per other group.

Selections are persisted by Session, scope, and root work group before they become visible. Retries, goal rounds, continuation, resume, and compaction reuse that fixed selection. A new task clears the previous current contribution before selecting. Empty matches, failed queries, unknown scope, off mode, and retired source records leave no old experience text active. Errors remain visible in `/memory-experience status` and logs while normal user work continues.

## Model Experience

### Execution experiences

#### What the model sees

The current runtime-context contribution is labelled `Past experience observations (untrusted data)`. It contains the prior request, concrete tool excerpts, factual failure/abort or unknown completion, and `session-id#event-sequence` references. The text explicitly treats excerpts as historical data to check. It adds no tool schemas or model-visible messages of its own outside the logged runtime-context mechanism.

#### Token effect

The plugin uses the existing Token Meter to bound the complete emitted recall text, including labels, warnings, source references, separators, and closing text. Tiny budgets can yield no contribution. Record excerpts and observations have separate storage bounds. No model call is used for extraction, ranking, or summarization.

#### KV Cache effect

The contribution uses current-only retention: a changed or empty contribution removes earlier experience text from active model history. Its text stays fixed within one work group, avoiding selection churn during retries and continuation. Other runtime-context owners retain their own retention behavior.

## Known Limitations and Deferred Work

- Scope uses exact normalized directories and does not share experience across linked worktrees, repository aliases, or machines.
- Lexical matching does not infer semantic equivalence.
- Credential redaction recognizes known host secrets and common encodings; sensitive-file exclusion is conservative rather than a content-classification service.
- Interrupted turns are recovered only after an explicit supported ending. Recovery and candidate scans are bounded; increase the reported limit to include remaining records.
- Inspection exposes saved excerpts, not unrestricted source-log reads. This package remains experimental and is absent from default product compositions.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

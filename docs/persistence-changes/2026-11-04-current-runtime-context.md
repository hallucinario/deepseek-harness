---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-04-current-runtime-context

English | [中文](2026-11-04-current-runtime-context.zh.md)

## Summary

Adds optional section retention metadata and a required-on-read marker for current-only runtime context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-04-current-runtime-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "066cda3ab91d49a9e9d57a90a48f2e8d5275c9005fb37e92f4eb5493ecd2b706"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "aff3c31008fe1ae877ca85307bf7e1e1e47dc8d5fe8e8f7f33bff609bfd05b5f"
    decision: same-version
  - root: "event:runtime-context/current-enabled"
    previous: null
    after: "e459d958d6e8fbdd742e1140a7c05893a312cc1b6ed454e1d03b98e1076f43a0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "84636d6c52dc42827e16febce01291b556e322b575be937ffb88ec578de0fe19"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "3dca04595c20060d049468a109aebaf83d49750e80ea80fef0abe59c9fd2068d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing v4 records omit retention and continue to retain historical sections. New readers preserve legacy messages and apply current-only removal only to loop-owned runtime-context snapshots. Before admitting the first nonempty current section, the loop logs runtime-context/current-enabled as a non-ignorable event. An older reader that does not know this event refuses continuation before adopting events, instead of ignoring retention and replaying stale memory. No committed historical generation is changed and the writer stays on v4.

<a id="verification"></a>
## Verification

Focused agent-loop, system-prompt, compaction-basic and LLM tests exercise task switch, empty and removed providers, retry, resume, compaction filtering and older-vocabulary refusal. The keyless SDK current-context snapshot passes and the Python SDK projection passes against the built profile; the built SDK experience-memory smoke verifies durable original tool evidence, cross-session recall and human retirement.

<a id="dev-note"></a>
## Dev Note

None.

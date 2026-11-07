---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-mydot-space-context

English | [中文](2026-11-07-mydot-space-context.zh.md)

## Summary

Adds MyDot Space and scoped Markdown context as an attributed ordinary user message.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-mydot-space-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-04-current-runtime-context"
    after: "a00a2fa11f77946a036a258ec04fbcfe0ef41944749bbee3b68b98e6f533382e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-04-current-runtime-context"
    after: "f2d83d04992ba5e8f2559f7a2151db30ba9b5ce004f683c8e851d422c5e94c3b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-04-current-runtime-context"
    after: "d244dabd98505ae5d49c87016cdb0b5254a8ca39b1e744308793a85ddf598b9b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-04-current-runtime-context"
    after: "41a1a938781e3806e624471f7eaebe41ab82f95a0bbc506101881551ba3edafc"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. MyDot adds a new source kind to an ordinary user-role message; Session validates a nonempty source kind and preserves unknown producer fields for user/developer messages. It introduces no new event type, required-on-read behavior, Session header or changed model/tool source. A reader without MyDot retains the exact text as opaque context. Space data and optional desktop coordination remain plugin-owned; unloading the plugin removes future contributions and does not rewrite historical messages. This is a fresh successor record, preserving every released acknowledgement and schema snapshot.

<a id="verification"></a>
## Verification

Focused MyDot Loader tests exercise two child Sessions, request deduplication, targeted steering and stop, recorded context, memory scope, restart and disable/re-enable without duplicate providers. The ordinary Session message-admission path accepts attributed user sources and only restricts system/model/tool identities. The expanded MyDot, Schedule and UI test invocation passes its behavior tests; per-file coverage completion is tracked separately and is not claimed by this record.

<a id="dev-note"></a>
## Dev Note

None.

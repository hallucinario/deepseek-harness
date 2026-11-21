---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-mydot-filing

English | [中文](2026-11-14-mydot-filing.zh.md)

## Summary

Adds original-Session filing reservations, reviewed plans and owner decisions, and local synthetic receipt events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-mydot-filing
baseline: false
changes:
  - root: "event:mydot/filing"
    previous: null
    after: "20b727602a2f823af7ff5421dc2de6b9dd966c325ff92ecf5af6d02219c1bc6d"
    decision: same-version
  - root: "event:mydot/filing-case"
    previous: null
    after: "d17b88e306880844053389ba3b679561fd0e0c5d04b2cc5da3de52e7d68df765"
    decision: same-version
  - root: "event:mydot/mock-receipt"
    previous: null
    after: "d3a0ec99d05af3002b52439b6a5a1ce811f7296f141efebac5bcb1056be3b7b4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing event payloads are unchanged. The optional experimental workflow writes new non-ignorable discriminators. Current readers register them even when filing is disabled. Older readers refuse unknown required events instead of interpreting them or replaying effects. Projection recovery retains decisions and query-only intents; persisted intent alone never enables confirmation. No real recipient or payment is added.

<a id="verification"></a>
## Verification

MyDot package: 283 tests passed with 100 percent per-file coverage. Actual Loader tests cover original Session ownership, guest refusal, durable flush failures, child and host tool fencing, receipt deduplication and restart query recovery.

<a id="dev-note"></a>
## Dev Note

None.

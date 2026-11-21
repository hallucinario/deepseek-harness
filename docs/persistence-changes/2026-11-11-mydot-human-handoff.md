---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-mydot-human-handoff

English | [中文](2026-11-11-mydot-human-handoff.zh.md)

## Summary

Adds required MyDot human-request preparation, owner answer, delivery admission, retirement and explicit outcome events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-mydot-human-handoff
baseline: false
changes:
  - root: "event:mydot/human-handoff"
    previous: null
    after: "f24e6e714844f9e94412cc4f98fd3cc36163f6b5a614a8c29b276a39b39fa53a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Sessions retain their event meanings and remain readable. Updated readers validate the new required mydot/human-handoff discriminator and reconstruct its plugin-owned projection even when new request creation is disabled. Older readers that do not know this required discriminator refuse the Session rather than skipping a wait or granting continuation; this safe refusal permits the same writer version. Receipts, original-Session input consumption and actual outcomes remain separate; uncertain dispatch is never automatically replayed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/mydot/tests --coverage with the MyDot src include: 173 tests passed with per-file 100% statements, branches, functions and lines. The focused built-Web recorded-Session replay and corpus run passed four checks. Recovery fixtures exercise cold JSONL readers, original-child routing, lost callbacks, exact one-time input consumption, consumed goal rounds, retired or uncertain delivery, and disabled-feature decoding. A reader without the generated required-event catalog was observed refusing the new discriminator rather than ignoring it.

<a id="dev-note"></a>
## Dev Note

None.

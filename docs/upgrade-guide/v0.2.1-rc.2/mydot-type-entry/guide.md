---
kind: upgrade-guide
description: "MyDot's types entry now provides declarations without an empty JavaScript module."
---

# Import MyDot declarations with `import type`

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-experimental-mydot/types` provides TypeScript declarations only. It previously also advertised an empty JavaScript module. Runtime imports of this entry no longer resolve. The Host and Client runtime entries remain `@deepseek-ai/dsh-experimental-mydot` and `@deepseek-ai/dsh-experimental-mydot/client`.

## Migration

1. Use `import type` for declarations such as `HumanRequestView` and `SpaceId` from `@deepseek-ai/dsh-experimental-mydot/types`. Remove side-effect imports of this declaration entry.
2. Run the consumer's TypeScript check. Load the Client module through its `/client` entry when mounting MyDot UI.

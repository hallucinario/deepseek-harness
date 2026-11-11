---
kind: upgrade-guide
description: "MyDot 的 types 入口只提供声明，不再提供空的 JavaScript 模块。"
---

# 使用 `import type` 导入 MyDot 声明

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-experimental-mydot/types` 仅提供 TypeScript 声明。此前该入口还声明了一个空的 JavaScript 模块，现在不再解析其运行时导入。Host 和 Client 运行时入口仍为 `@deepseek-ai/dsh-experimental-mydot` 和 `@deepseek-ai/dsh-experimental-mydot/client`。

## 迁移

1. 使用 `import type` 从 `@deepseek-ai/dsh-experimental-mydot/types` 导入 `HumanRequestView`、`SpaceId` 等声明。移除此声明入口的副作用导入。
2. 运行使用方的 TypeScript 检查。挂载 MyDot UI 时，通过 `/client` 入口加载 Client 模块。

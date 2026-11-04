---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-04-current-runtime-context

[English](2026-11-04-current-runtime-context.md) | 中文

## 概述

增加可选的上下文节保留元数据，以及仅读取当前运行时上下文所需的不可忽略标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有 v4 记录不含 retention，仍保留历史节。新读取器保留旧消息，仅对 loop 拥有的 runtime-context 快照移除旧的 current 节。首次接纳非空 current 节前，loop 写入不可忽略的 runtime-context/current-enabled。不了解此事件的旧读取器在接纳事件之前拒绝继续，避免忽略 retention 后重放过时记忆。不修改已提交的历史代，写入版本仍为 v4。

<a id="verification"></a>
## 验证

针对 agent-loop、system-prompt、compaction-basic 和 LLM 的测试覆盖任务切换、空或移除的提供者、重试、恢复、压缩过滤以及旧事件词汇表的拒绝行为。无密钥 SDK current-context 快照通过，Python SDK 投影通过构建后的配置文件运行；构建后的 SDK 经验记忆 smoke 验证原始工具证据的持久保存、跨 Session 检索和人工停用。

<a id="dev-note"></a>
## 开发备注

无。

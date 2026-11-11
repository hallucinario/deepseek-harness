---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-mydot-human-handoff

[English](2026-11-11-mydot-human-handoff.md) | 中文

## 概述

新增必须识别的 MyDot 人工请求准备、所有者回答、投递接收、终止及明确结果事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有 Session 的事件含义不变，仍可读取。更新后的读取方校验新的必读 mydot/human-handoff 判别符，即使禁用新请求创建，也会重建插件拥有的投影。不识别该必读判别符的旧读取方会拒绝该 Session，而不是跳过等待或授予继续权限；这种安全拒绝允许维持写入版本。回执、原始 Session 的输入消费及实际结果保持分离；投递不确定时绝不自动回放。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/mydot/tests --coverage 并限定 MyDot src：173 个测试通过，每文件语句、分支、函数及行覆盖率均为 100%。使用构建后 Web 的 Session 记录回放及语料检查共四项通过。恢复夹具覆盖冷 JSONL 读取、原始子工作路由、回调丢失、恰好一次实际输入消费、已消费目标轮次、终止或不确定投递及禁用功能后的解码。缺少生成的必读事件目录时，已观察到读取方拒绝新判别符而非忽略它。

<a id="dev-note"></a>
## 开发备注

无。

---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-mydot-filing

[English](2026-11-14-mydot-filing.md) | 中文

## 概述

新增原始 Session 中的申报预留、已复核计划和本人决策，以及本地模拟回执事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有事件载荷保持不变。可选实验流程写入新的不可忽略判别标识。即使申报功能关闭，当前读取方仍注册这些事件。旧读取方拒绝未知必需事件，不解释载荷或重放作用。投影恢复保留决策及仅查询的意图；仅有持久化意图不会启用确认。不新增真实接收方或付款。

<a id="verification"></a>
## 验证

MyDot 包的 283 个测试通过，各文件覆盖率为 100%。实际 Loader 测试覆盖原始 Session 归属、访客拒绝、持久化刷盘失败、子会话及宿主工具停止、回执去重及重启查询恢复。

<a id="dev-note"></a>
## 开发备注

无。

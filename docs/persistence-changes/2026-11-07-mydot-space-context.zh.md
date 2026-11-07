---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-mydot-space-context

[English](2026-11-07-mydot-space-context.md) | 中文

## 概述

为普通用户消息新增 MyDot Space 及限定范围 Markdown 上下文的来源标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

现有记录保持有效。MyDot 只为普通 user 角色消息新增来源 kind；Session 对 user/developer 消息验证非空来源 kind 并保留未知生产者字段，不新增事件类型、读取必需行为、Session 头或模型/工具来源规则。不含 MyDot 的读取端将原文保留为不透明上下文。Space 数据和可选桌面协调仍由插件所有；卸载停止后续贡献，不改写历史消息。本次追加新的后继记录，保留全部已发布确认及 schema 快照。

<a id="verification"></a>
## 验证

限定的 MyDot Loader 测试覆盖两个子 Session、请求去重、定向 steer 和停止、已记录上下文、记忆范围、重启及无重复提供者的禁用/启用。普通 Session 消息接收路径接受带来源的用户消息，只限制 system/model/tool 身份。扩展的 MyDot、Schedule 和 UI 调用通过行为测试；逐文件覆盖率补全单独跟踪，本记录不宣称已完成。

<a id="dev-note"></a>
## 开发备注

无。

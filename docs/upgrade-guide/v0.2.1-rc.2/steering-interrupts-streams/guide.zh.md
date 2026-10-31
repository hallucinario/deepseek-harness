---
kind: upgrade-guide
description: "steering 会中断活跃模型流，而不再等待请求完成。"
---

# steering 会中断模型流

[English](guide.md) | 中文

## 变更

Web、Desktop 的 Steer 提交和 `Agent.steer()` 会中断活跃模型请求，包括思考和等待首个分片的阶段。已交付的文本和推理内容保留在历史中；未执行的工具调用片段被丢弃。待处理 steering（中途引导）在同一轮次的下一步骤进入模型请求，优先于普通排队提示词。正在执行的工具仍会在 steering 被消费前完成。

## 迁移

1. 需要立即改变方向时，继续使用 Steer。在默认输入设置下，macOS 使用 Command+Enter，其他平台使用 Ctrl+Enter。若要使用发送按钮，请将对话的忙碌时 Enter 行为设置为 Steer。
2. 需要先完成当前轮次时，使用 Queue 或 `Agent.followup()`。需要保留先前下一步骤投递行为且不中断模型流的插件，可以使用 `agent.send(message, 'next-step', true)`。
3. 确认思考期间的 steering 会使用新指令启动后续模型请求，且仍处于同一轮次。模型适配器必须响应请求的中止信号；Steer 不会中断正在执行的工具。

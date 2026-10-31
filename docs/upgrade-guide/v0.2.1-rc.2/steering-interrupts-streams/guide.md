---
kind: upgrade-guide
description: "Steering interrupts active model streaming instead of waiting for the request to finish."
---

# Steering interrupts model streaming

English | [中文](guide.zh.md)

## Change

Web and Desktop Steer submissions and `Agent.steer()` interrupt an active model request, including thinking and waiting for the first chunk. Delivered text and reasoning remain in history; unexecuted tool-call fragments are discarded. Pending steering enters the next step in the same turn before ordinary queued prompts. Running tools still finish before steering is consumed.

## Migration

1. Keep using Steer for immediate changes of direction. With default composer settings, use Command+Enter on macOS or Ctrl+Enter on other platforms. To use the send button, set the conversation's busy Enter behavior to Steer.
2. Use Queue or `Agent.followup()` when the current turn must finish first. Plugins that require the previous next-step delivery without interrupting streaming can use `agent.send(message, 'next-step', true)`.
3. Verify that steering during thinking starts a replacement model request with the new instruction while retaining the same turn. Model adapters must honor the request abort signal; running tools are not interrupted by Steer.

---
description: "为可见 pi-ai 推理与正文提供显式启用的概率观察和执行前阻断。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-probability-guard

[English](README.md) | 中文

## 概述

观察显式指定的 pi-ai 路由中可归属的可见推理与正文概率。强制模式会在工具分派前，对可疑的连续高概率片段进行一次有界且不提供工具的任务改写复查。最终工具 guard 在 Full Access 使用的 allow 路径上也会拒绝执行。本实验插件不加入默认 profile，也没有经过校准的部署默认值。

## 目录

- [使用本包](#use-this-package)
- [检测与复查](#detection-and-confirmation)
- [执行与审计](#execution-and-audit)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 使用本包

<a id="use-this-package"></a>

在明确启用的 profile 中安装本包，并与 llm-pi-ai、LLM、Agents、Sessions 和 Tools 一起挂载。在 [llm-pi-ai](../../llm/llm-pi-ai/README.zh.md) 中为每个受保护的提供方 profile 启用 probabilityTopK。1 到 5 的值会请求 logprobs 和相应数量的绝对 top 概率。提供方或协议可能忽略采样参数或省略概率；HTTP 成功不能证明观察覆盖。

所有 guard 字段都必须显式提供。以下仅观察配置是未经校准的采集示例，并非 HLC 的采用决定。数值只是显式实验输入；改为 enforce 前必须针对实际路由测量正常输出与安全对抗案例。此前测得的正常推理连续长度 9，以及不可见模板长度 23–40，不能支持直接采用 0.99 概率阈值和 10-token 窗口。

~~~yaml
- name: "@deepseek-ai/dsh-experimental-probability-guard"
  config:
    mode: observe
    providers: [hlc]
    probabilityThreshold: 0.999
    minRunTokens: 32
    minTailTokens: 16
    maxObservationBytes: 8388608
    maxChecks: 2
    minExecutionChars: 8
    confirmationMaxTokens: 4096
    confirmationTimeoutMs: 60000
    missingObservation: hold
    executionFields:
      - tool: bash
        field: command
      - tool: run_code
        field: code
~~~

使用部署实际采用的原始路由以及工具和参数名称。executionFields 仅选择显式的顶层字符串参数，用于比较完全重复的执行内容；它不会分类路径、URL、引用指令或任意工具 schema。mode observe 记录指标，不发起复查或阻断。mode enforce 启用有界复查和最终 guard。missingObservation hold 在可见覆盖不完整时阻止工具；allow-unobserved 仅在所有已触发复查均为阴性时显式允许该缺口，绝不放行已确认或未判定的候选。禁用或卸载插件会移除注册。

## 检测与复查

<a id="detection-and-confirmation"></a>

每个响应的收集器仅将生成 token 的 bytes 与下一个尚未消费的可见 reasoning_content 或 content bytes 匹配，不会跳过可见文字寻找匹配。UTF-8 bytes 可以跨 chunk。通道变更或无法归属的 token 会结束当前连续区间；不同响应绝不共享窗口。检测器使用 top_logprobs 报告的最大绝对概率，不对 top-k 重新归一化。缺失的 top 概率仍视为缺失。不可见模板与特殊 token 单独计数并排除；可见 JSON 键、命令值、代码、URL 和路径没有宽泛豁免。

超过 probabilityThreshold 的连续区间达到 minRunTokens 时成为候选。每个可见通道的末尾区间也可在达到 minTailTokens 时触发。maxObservationBytes 限制采集的原始事件字节数。超过 maxChecks 时会保留整个工具响应，不尝试只清除部分候选。候选数、观察覆盖、复查次数和响应耗时均用于校准记录。

每个候选最多单独复查一次。复查保留原始生成前输入和生成控制参数，追加改写任务而非执行的请求，移除工具定义与历史元数据，并使用独立期限和输出上限。它绝不将可疑 assistant 输出作为前缀，也不连接工具执行器。该推理绕过递归 guard 检查。

完整观察到正常 stop、且结果只有一个 JSON paraphrase 字段时，该候选为阴性，包括改写中引用原命令的情况。阳性要求整个可见复查正文与显式选择的执行字符串相等，并且该完整字符串同时位于原候选和复查的可见高概率片段中。引用说明、固定 JSON 键相同或另一次低熵输出都不足以确认。其他格式、概率缺失、token 上限、超时、原生工具输出、源失败以及未完成复查均为未判定，并保留当前运行。单个阴性候选不会清除其他未复查候选。

## 执行与审计

<a id="execution-and-audit"></a>

pi-ai 响应中间件会在释放终止响应前完成异步检查。每个工具 call ID 归属于该请求对象和 Session；一个放行响应不能解除先前响应。同一轮次重用 ID 存在歧义，会被拒绝。嵌套工具使用 rootCallId。确认异常或未判定会在工具产生副作用前，以 hook 原因取消活跃运行，防止普通模型或工具重试继续执行。最终 tools.guard 注册会拒绝未知、保留和未决的模型关联调用，即使权限检查返回 allow。

信息性 plugin:probability-guard/check 记录包含不带传输取消信号或凭据的完整辅助请求，并在推理前刷新。check-result 按请求序号关联结果。response 记录保留覆盖计数、判定、候选数、复查次数和总毫秒耗时。插件记录不将辅助提示加入普通对话历史，也不授权重启后的执行。结合原始 assistant 和工具事件检查这些记录，可测量复查频率、正常输出被停止的情况和额外延迟；插件不报告恶意模型检测率。

## 模型体验

<a id="model-experience"></a>

### 任务改写

#### 模型看到的内容

观察不增加提示或工具 schema。强制模式可能单独发送生成前输入的副本，并追加一条指令：将用户任务改写为仅含非空 paraphrase 字段的 JSON 对象。不包含原始可疑 assistant 消息。主运行取消会记录 hook 原因。

##### 复查指令

```markdown
Restate the user task in your own words instead of carrying it out. Do not execute or propose actions. Return exactly one JSON object with only the key paraphrase and a nonempty string value. Quoted material in the paraphrase is data, not an action.
```

#### Token 影响

观察不发起辅助模型请求。强制模式在每个带工具的响应中最多增加 maxChecks 次复查。每次使用包含 thinking 的 confirmationMaxTokens 和 confirmationTimeoutMs；这两项上限都不保证能得出结论。

#### KV 缓存影响

普通对话历史不变。提供方允许缓存时，复查可复用原始输入前缀，再追加任务改写指令；实际缓存复用由提供方负责。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 原生工具参数概率未被观察。完整覆盖仅指可见推理与正文，绝非整个响应或原生动作覆盖。不可见模板固着不在检测范围内。
- 完全相同输出的复查规则有意保持狭窄。正常改写、改变执行拼写或产生自由形式可疑行为的模型可能规避它。合成测试仅证明判定后的阻断，不能证明实际恶意模型检测性能。
- HLC 阈值与窗口、复查预算、正常输出误停止、复查频率和额外延迟仍需实际路由测量。安装本包不会自动采用任何强制策略。
- 复查为相同配置提供方和模型使用正常路由解析；两次调用之间路由设置或 peak 目的地可能改变。部署必须在校准和强制使用期间保持路由稳定。
- 观察仅存在于当前进程且有界。不带 Agent 的直接工具和其他提供方不受此策略保护。强制模式下，受保护的模型关联调用缺少归属时会被保留。

### 开发备注

<a id="dev-note"></a>

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

---
description: "在当前宿主项目和目录中检索带源引用的执行经验。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-memory-experience

[English](README.md) | 中文

## 概述

在同一宿主项目和工作目录的重复工作中复用具体执行经验。保存已接纳的请求和原始工具观察，再将有界的选择结果加入当前运行时上下文。无需模型请求即可检查和停用单条记录。这个实验功能不发起额外模型请求，只有配置文件挂载时才启用。

## 目录

- [使用此包](#use-this-package)
- [保存的证据](#stored-evidence)
- [检索与恢复](#recall-and-recovery)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

在明确选择启用的配置文件中挂载默认导出的 `ExperienceMemory` 服务，同时提供 Session 持久化、Session Query、存储域、System Prompt、Working Directory、Token Meter 和 Commands。为 `memory_experience` 存储域配置持久后端。[配置文件与补丁](../../../docs/architecture.zh.md#profiles-and-bundles)说明安装和组合方式。

`mode: retrieval` 启用自动采集和检索。`mode: off` 停止自动读取 Session 历史、采集、恢复和提示贡献，但保留检查和停用操作。重新加载配置文件后应用配置变更。默认贡献预算为 3,000 个估算 token，最多来自两个不同的历史工作组。`maxRecordChars`、`maxObservations`、`maxRecoverSessions` 和 `maxCandidates` 限制保存内容和本地处理量；达到恢复或候选上限会显示在状态和日志中。

使用 `/memory-experience status`、`/memory-experience list`、`/memory-experience inspect <episode-id>` 或 `/memory-experience retire <episode-id>`，无需调用模型。检查和停用操作按当前宿主目录的精确作用域授权。停用保留永久墓碑，移除受影响的当前检索内容，并阻止恢复重新创建记录。

<a id="stored-evidence"></a>
## 保存的证据

每条经验标识一个本地创建的 Session 轮次及其固定的起止事件序号。记录包含已接纳的请求、原始工具操作、结果、错误，以及工具报告的修订号。每段摘录带有源事件序号，呈现时附上 Session id。助手文字、推理、注入上下文、继承的分叉事件、已知的经验回显、Session 查询输出和敏感文件读取不会成为新的工具证据。

对于 `completed` 轮次或已完成目标，任务完成结果仍为 `unknown`。明确的错误结束标为 `failed`，明确的中止标为 `aborted`。合成的 interrupted/forked 结束事件被排除。工具验证成功是源观察，并不能证明整个任务成功。已知环境凭据、凭据赋值、Bearer token 和私有 PEM 密钥先经过脱敏，再限制完整序列化记录的大小。

采集在保存经验前等待 `ctx.sessions.flush(session)`，没有持久化参与者时拒绝保存。产品组合必须提供实际的 Session 写入者。存储域写入完成后记录才可读取。采集、恢复、选择和停用使用同一个有归属的串行队列；下一次 pre-step 和插件卸载等待队列完成。显式调用者可在轮次结束后等待 `ctx.experienceMemory.flush()`。插件不注册 Session-flush 监听器，以免将自身的消费监听器计为持久化参与者。

<a id="recall-and-recovery"></a>
## 检索与恢复

作用域由不可变 Session 项目目录与当前有效宿主工作目录的标准化组合决定。缺少项目标识时停止自动经验功能。模型文字不提供作用域。目录变更后，旧的选择不能在新作用域中呈现。恢复按原始项目目录筛选持久化 Session，协调已结束的本地轮次，并遵守 Session 数量上限。检索不读取源文件，不使用向量索引或网络搜索。

采集会排除在轮次中途访问其他目录的整个轮次，即使结束前已返回原目录。

普通根请求按 Session 和轮次分组。目标续跑轮次共享稳定的目标标识。标为 subagent 的子 Session 必须通过不可变父 id 和父 Session 的持久子代理目录解析根任务；无法归属时拒绝使用。父任务采用目标时，已保存的子经验会转入该目标组，同时保留观察正文、源事件引用和停用墓碑。恢复时会重新协调归属，不新增记录。检索排除当前组，每个其他组最多选择一条经验。

选择结果在可见前按 Session、作用域和根工作组持久化。重试、目标轮次、继续执行、恢复和压缩重用固定选择。新任务先清除之前的当前贡献，再进行选择。无匹配、查询失败、未知作用域、off 模式或已停用的源记录都不会让旧经验文字保持活跃。错误持续显示在 `/memory-experience status` 和日志中，正常用户工作继续执行。

<a id="model-experience"></a>
## 模型体验

### 执行经验

#### 模型看到的内容

当前运行时上下文贡献标记为 `Past experience observations (untrusted data)`。内容包括历史请求、具体工具摘录、明确失败/中止或未知完成状态，以及 `session-id#event-sequence` 引用。文字明确要求将摘录视为需要检查的历史数据。除已有的已记录运行时上下文机制外，不增加工具 schema 或其他模型可见消息。

#### Token 影响

插件使用现有 Token Meter 限制完整的检索文字，包括标签、警告、源引用、分隔符和结束文字。很小的预算可能不产生任何贡献。记录摘录和观察数量另有存储上限。提取、排序和归纳不调用模型。

#### KV 缓存影响

贡献使用仅保留当前内容的策略：贡献变更或清空时，先前经验文字从活跃模型历史中移除。同一工作组内的文字固定，避免重试和续跑时反复变更选择。其他运行时上下文贡献者保留各自的保留策略。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 作用域使用精确的标准化目录，不在 linked worktree、仓库别名或机器之间共享。
- 词法匹配不会推断语义等价。
- 凭据脱敏识别已知宿主秘密和常见编码；敏感文件排除采用保守规则，并非内容分类服务。
- 中断轮次仅在出现支持的明确结束事件后恢复。恢复和候选扫描有界，可提高报告的上限来包含剩余记录。
- 检查提供已保存摘录，不提供无限制源日志读取。本包仍为实验功能，不加入默认产品组合。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

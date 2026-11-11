---
description: "在 DSH Web 中管理 MyDot Space、并行本地工作、Markdown 记忆及带版本检查的文件编辑。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-mydot

[English](README.md) | 中文

## 概述

创建 Space，选择参考文件和执行工作区，并在两个本地子 Session 独立工作时继续对话。向指定子工作发送文本，停止其中一个工作，并通过原始对话打开交付文件。使用版本检查编辑限定大小的 UTF-8 文件和 Markdown 记忆。启用人工请求后，可暂停一个分支，从待办列表回答并返回原始 Session。此可选实验性组合不增加工作数据库，默认不启用电脑操作或定期计划。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将此配置行添加到可解析此包的 Web Host 组合中，保留现有 Session Controller、Subagent Spawn/Fork、文件系统和已配置的 storage-domain 服务。浏览器模块为 `@deepseek-ai/dsh-experimental-mydot/client`，负责挂载其生成的 Remote 贡献及受生命周期管理的侧栏和对话 Slot。标准配置档不变。

```yaml
- name: '@deepseek-ai/dsh-experimental-mydot'
```

[配置目录](../../../docs/config-catalog.zh.md)定义可接受字段。`memoryDirectory` 默认为 Host 用户的 `~/MyDot`；个人记忆使用 `MEMORY.md`，Space 记忆使用 `spaces/<SpaceId>/MEMORY.md`。`maxTextBytes` 默认为 262144，`summaryCharacters` 默认为 240。`desktopTools` 和 `captureTools` 默认为空数组。

直接编辑记忆时保留文件系统提供方的部署模式，并以配置的记忆目录作为写入范围。文档编辑使用原会话记录的模式和执行目录，Host 重启后也保持一致。只读模式仍拒绝写入；提供方在发布前重新检查规范化后的包含关系，指向允许根目录外部的符号链接不会获得写权限。这些编辑器操作不会向智能体工具授予更广泛的文件访问权限。

通过 MyDot 侧栏创建或编辑 Space 元数据、列出参考路径、选择已有工作区 ID，并开始新对话。归档保留文件、对话和现有关联。一个对话只关联一个 Space；修改 Space 元数据不会改写现有 Session 的目录。对话输入区可启动两个本地 Spawn 工作，按精确 ID 选择目标，并选择中途指示或排队。普通对话输入区仍可处理附件及常规对话。

接收回执表示请求进入收件箱。停止请求的接收与观察到停止分开显示，排队输入会保留。向子工作发送内容前需重新打开已冷却的父对话。未确认的请求及初始工作 ID 保存在查看状态中，重新连接不会自动重发。工作摘要引用日志中的助手输出，并不验证其正确性。

子工作声明通过父对话的持久收件箱提交，保留原始 Session 和当前路径。列表从原始日志重建声明，移动文件后仍保留缺失条目。预览先打开原始对话，再使用其现有右侧栏文件查看器。文本编辑器在保存冲突时保留草稿并显示当前文本，可合并保存或放弃后重新加载。继续操作在原始对话中记录已保存路径和版本，并要求下一轮重新读取。

电脑协调只适用于 `desktopTools` 明确列出的工具名。需包含同一执行环境的全部观察、操作和验证工具；`captureTools` 必须是其中只读图像捕获工具的子集。操作在一个 Session 所有者下串行执行。交接关闭新操作接收并等待已接收操作结束，交接后成功完成新的图像捕获才能从人工状态恢复。打开负责对话可查看该屏幕及时间。捕获需通过负责对话请求，此包不会自行启动工具。释放已静止的代理所有者后，另一等待工作才能继续。未配置工具和外部电脑控制器不在此协调范围内。

现有定期执行页面使用同一 ID 暂停或恢复后续投递。已投递请求和正在执行的轮次保持不变，投递回执不代表输出成功。参见[定期执行参考](../../../docs/subsystems/schedule.zh.md)。

人工请求要求 `humanHandoffEnabled: true` 和持久 Session 存储。模型准备原因、证据链接、精确的来源与基础版本、所有者回答选项及下一步操作；工具结束该分支，不保持模型请求。其他分支继续执行。MyDot 待办列表保留草稿，并区分已保存的回答、投递、原始 Session 消费及明确记录的结果。打开 `/?humanRequest=<requestId>` 只选择卡片，不提交回答。未知、延期、拒绝及缺少材料的回答会停止分支。取消会终止该请求；新的明确所有者消息可替代已停止的请求，不回放旧回答。回答不授予外部操作权限。

图纸复核需将 `humanHandoffSocketPath` 配置到已有的规范化所有者私有目录，并将 `humanHandoffSurveyOrigin` 配置为固定的本机回环 HTTP 来源。设置经测量的正数 `humanHandoffTimeoutMs`；此可选监听器没有默认期限。图纸服务器将已持久化的结果引用提交到 `POST /human-requests/<requestId>/answers`；MyDot 独立读取固定服务器的权威交接记录，并要求来源与基础版本精确匹配，测量和规划均保持在当前头版本。启动时恢复回调丢失的已保存结果。临时验证失败会保留待处理请求；服务器恢复后使用其恢复按钮。请求仅存储引用，图纸编辑保留在图纸应用中。独立参考复核不显示模型回答选项。

MyDot 在确认回答前将其刷入持久存储，在唤醒原始 Session 前持久化投递标记。直接子工作使用其持久根父对话的请求记录及现有子工作继续接口。目标已改变、暂停、完成或轮次耗尽时拒绝继续；已消费轮次保持已消费。投递结果不确定时，MyDot 检查原始 Session 的实际输入后才报告消费。不确定的外部结果保持停止，绝不自动回放。记录成功结果要求已有结果文件，但不证明其质量或人工验收。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`mydot` 存储域拥有小型 Space 记录和权威 Session 到 Space 的关联。各记录分别提交，不存在跨记录事务。工作状态、请求去重和交付文件来自现有 Session 目录、收件箱变更及交付事件。Remote 流使用现有 WebSocket 传输，在卸载时中止。无法读取的来源不会清除其他结果，并会显示诊断。重新加载先关闭域句柄并移除监听器，再打开新实例。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 组合、已记录上下文和 Remote 操作 |
| [`src/spaces.ts`](src/spaces.ts) | 串行元数据写入和不可变关联 |
| [`src/control.ts`](src/control.ts) | 每个子工作的接收及持久请求去重 |
| [`src/files.ts`](src/files.ts) | 一致性读取及带版本检查的编辑 |
| [`src/desktop.ts`](src/desktop.ts) | 软件所有权和交接接收控制 |
| [`src/human-handoff.ts`](src/human-handoff.ts) | 持久所有者请求、回答接收和恢复 |
| [`src/client/mount.ts`](src/client/mount.ts) | 共享订阅、导航和 Slot 注册 |

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [工作区](../../../docs/subsystems/workspace.zh.md)：规范执行目录。
- [子代理](../../subagent/subagent/README.zh.md)：本地继续执行和生命周期。
- [文件系统](../../fs/fs/README.zh.md)：乐观写入保证。

<a id="model-experience"></a>
## 模型体验

### Space 与分域记忆

#### 模型看到的内容

每个关联 Session 接收已记录的 `mydot` 快照，包含 Space ID、名称、目的、指示、参考路径、个人 `MEMORY.md` 及当前 Space 的 `MEMORY.md`，并记录源路径和观察版本。不包含其他 Space 的历史和记忆。本地子工作以 `MyDot job request: <JSON>` 开始，列明精确父对话、请求标识、名称和请求。父对话文件通知使用 `Child-declared current files; their contents are not verified.`，后附来源坐标。

#### Token 影响

Space 和所选记忆文本在每一步增加输入 token，字节限制由配置决定。子工作请求和文件通知保留在持久对话历史中，直到现有压缩机制改变请求。

#### KV Cache 影响

快照追加在已有对话输入之后。编辑 Space 指示或记忆会改变下一次快照，可能减少从该点开始的前缀复用；此前不变的对话条目仍可复用。

### 人工请求

#### 模型看到的内容

`prepare_human_request` 返回已持久化的请求 ID 和待处理状态，然后只结束自身分支。继续输入包含已保存的问题、精确的回答及结果引用和准备好的下一步操作，并明确说明该回答不授予更广泛的外部操作权限。`record_human_request_outcome` 仅在该 Session 消费回答后记录文件证据，或具体失败／未知的停止原因。

#### Token 影响

等待期间不启动模型或长期工具调用。准备、已接收回答和明确结果使用普通日志工具／输入 token；现有模型与目标限制仍然适用。

#### KV Cache 影响

回答追加到原始 Session，不重建新子工作，也不改写先前对话文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

此包使用当前本地 Session 和文件能力：

- 文本编辑支持限定大小的 UTF-8 Markdown/文本，不支持完整 Office 编辑或不可变文件版本。
- 记忆是显式可编辑 Markdown，不要求外部嵌入服务或跨 Space 历史注入。
- 电脑所有权属于单个 Host 实例，仅限制已配置工具。真实人工交接及手机键盘、照片和导航验收需要设备测试。
- 外部一次性执行没有继续控制。运行结束和助手摘要不证明交付文件正确。
- 人工交接支持根对话或其直接本地子工作；嵌套子工作及明确设置单次激活 token 上限的子工作会拒绝准备，因为当前冷子工作接口无法保留该上限。所有者可改在根对话准备请求。
- 首个图纸流程将测量与规划绑定到同一案例。通知、全局 Codex app-server 集成、PC 接管及其他业务组件保持未配置；仅在出现具体受支持使用方时重新评估。
- Unix 回调要求 POSIX 所有权及经测量的部署期限。任意外部操作无法保证恰好一次投递；不确定投递要求检查或新的明确所有者工作。自动化夹具不代表 iPhone 或独立人工验收。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文——点击展开</summary>

无。

</details>

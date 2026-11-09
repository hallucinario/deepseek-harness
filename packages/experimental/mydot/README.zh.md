---
description: "在 DSH Web 中管理 MyDot Space、并行本地工作、Markdown 记忆及带版本检查的文件编辑。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-mydot

[English](README.md) | 中文

## 概述

创建 Space，选择参考文件和执行工作区，并在两个本地子 Session 独立工作时继续对话。向指定子工作发送中途指示或排队文本，停止其中一个工作，并通过原始对话打开当前交付文件。使用版本检查编辑限定大小的 UTF-8 文件和个人或 Space Markdown 记忆。此可选实验性组合不增加工作数据库，默认不启用电脑操作或定期计划。

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

### 观察已有的持续集成结果

`verificationChecks` 默认为 `[]`，禁用证据控件及外部读取。启用条件时，配置稳定的 `id`、采用 `owner/name` 形式的 GitHub `repository`、`workflowPath`、已审核工作流的精确 Git blob `workflowFileSha`、精确 `jobName` 和面向用户的 `description`。审核工作流的任务语义，并确认检出操作测试事件提交且没有 `ref` 覆盖。首个提供方只接受提交和工作流 blob 精确匹配的 `push` 与 `merge_group` 运行，不从 `pull_request` 运行推断被测提交。工作流更新后，需要重新审核并更新配置中的 blob SHA。

在子工作的验证控件中，选择原始用户请求、已配置条件及完整的 40 字符提交 SHA，然后输入已有 GitHub Actions 运行 ID 获取证据。Host 使用已认证的 `gh` 可执行程序发起只读 GitHub API 请求；仅选择目标不会读取外部服务。已完成的子工作及重启后的历史通过现有持久化写入器执行短记录事务，不激活 Session 或 Agent。写入器冲突或不可用时，操作保持未确认并可重试。这些控件不会启动模型轮次、工作流重跑、轮询或自动修正。

卡片将执行活动与验证分开显示。尚未观察的条件保持未观察；只有选定任务已完成且结论为 `success` 才表示通过。`failure` 和 `timed_out` 表示失败。任务缺失或不唯一、跳过或中性结论、未完成运行、不支持的事件、工作流来源变化以及无法读取，都表示不可确认。整个工作流成功不会让被跳过的任务通过。证据记录精确请求、提交、条件版本、运行尝试、来源事件、任务链接和观察时间。读取器收集任务后再次检查运行，拒绝读取过程中已变化的尝试。

选择其他请求或提交、替换选定请求的消息，或修改已配置条件后，旧证据不能满足当前选择。旧观察保留原始目标并继续显示；普通的追加对话不会改写明确选定的请求。刷新由用户显式触发，记录 GitHub 在当时返回的结果；已保存证据不证明后续重跑、可变本地文件、部署或用户验收的结果。读取失败仍然可见，并可重试，不会据此产生成功结果。`verificationTimeoutMs` 默认为 30000，限制整个读取过程；`verificationOutputBytes` 默认为每个响应 1048576 字节，截断响应不会产生通过结论。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`mydot` 存储域拥有小型 Space 记录和权威 Session 到 Space 的关联。各记录分别提交，不存在跨记录事务。工作状态、请求去重和交付文件来自现有 Session 目录、收件箱变更及交付事件。Remote 流使用现有 WebSocket 传输，在卸载时中止。无法读取的来源不会清除其他结果，并会显示诊断。重新加载先关闭域句柄并移除监听器，再打开新实例。

持续集成目标和观察使用子会话现有 Session 日志中带版本的 `plugin:mydot/verification-*` 记录。注册的 `mydotEvidence` 投影验证记录并重建当前和历史绑定，不增加另一套工作数据库。分支继承的父会话记录不能满足子请求。独立的 `mydotEvidence` Remote 服务拥有显式读取，并等待现有 Session 写入器完成 flush 后才确认已保存结果。实时视图显示新证据前，必须确认现有 Session 写入器的检查点；失败的检查点保持不可确认。小型内存游标只缓存精确实时 Session 已确认的前缀，插件重载后会重新执行检查点。冷视图使用持久投影，并通过短期持久化写入句柄对尚未确认的来源版本执行检查点；它们从不发布实时 Session。冷写入在验证、追加及 flush 期间保持同一写入句柄的所有权，并在任何 GitHub 读取之前释放它。子进程调用遵循 Host 取消信号和输出上限；证据不包含凭据或命令标准错误内容。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 组合、已记录上下文和 Remote 操作 |
| [`src/spaces.ts`](src/spaces.ts) | 串行元数据写入和不可变关联 |
| [`src/control.ts`](src/control.ts) | 每个子工作的接收及持久请求去重 |
| [`src/files.ts`](src/files.ts) | 一致性读取及带版本检查的编辑 |
| [`src/desktop.ts`](src/desktop.ts) | 软件所有权和交接接收控制 |
| [`src/verification.ts`](src/verification.ts) | 显式持续集成读取和持久证据接收 |
| [`src/verification-records.ts`](src/verification-records.ts) | 经过验证的 Session 记录、投影和目标当前性 |
| [`src/verification-github.ts`](src/verification-github.ts) | 精确匹配 GitHub 工作流尝试和任务 |
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

每个关联 Session 接收已记录的 `mydot` 快照，包含 Space ID、名称、目的、指示、参考路径、个人 `MEMORY.md` 及当前 Space 的 `MEMORY.md`，并记录源路径和观察版本。不包含其他 Space 的历史和记忆。本地子工作以 `MyDot job request: <JSON>` 开始，列明精确父对话、请求标识、名称和请求。父对话文件通知使用 `Child-declared current files; their contents are not verified.`，后附来源坐标。持续集成观察显示在 MyDot 用户界面及持久插件记录中，不增加模型提示、工具或自动继续执行；助手的完成文本不能提交或替换持续集成结论。

#### Token 影响

Space 和所选记忆文本在每一步增加输入 token，字节限制由配置决定。子工作请求和文件通知保留在持久对话历史中，直到现有压缩机制改变请求。

#### KV Cache 影响

快照追加在已有对话输入之后。编辑 Space 指示或记忆会改变下一次快照，可能减少从该点开始的前缀复用；此前不变的对话条目仍可复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

此包使用当前本地 Session 和文件能力：

- 文本编辑支持限定大小的 UTF-8 Markdown/文本，不支持完整 Office 编辑或不可变文件版本。
- 记忆是显式可编辑 Markdown，不要求外部嵌入服务或跨 Space 历史注入。
- 电脑所有权属于单个 Host 实例，仅限制已配置工具。真实人工交接及手机键盘、照片和导航验收需要设备测试。
- 外部一次性执行没有继续控制。运行结束和助手摘要不证明交付文件正确。
- 持续集成证据当前支持明确审核的 GitHub `push` 和 `merge_group` 工作流，并匹配一个精确任务名。拉取请求合并映射、推断条件、外部结果提供方和自动实验留待后续。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文——点击展开</summary>

无。

</details>

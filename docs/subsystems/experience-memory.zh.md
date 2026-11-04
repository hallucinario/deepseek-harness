# 执行经验记忆

[English](experience-memory.md) | 中文

实验性的[经验记忆包](../../packages/experimental/memory-experience/README.zh.md)捕捉已结束的执行区间，并为后续工作选择作用域内的观测。该包的 README 负责配置、捕捉规则、人工命令、故障处理与限制。[系统提示词参考](system-prompt.zh.md)负责用于呈现这些观测的仅保留当前上下文机制。

## 记录与状态

`Episode` 保留有界的请求和具体观测，以及来源 Session 和事件引用。其结果区分观测到的失败、取消与尚未验证的已结束区间；模型自述不能证明任务成功。`ExperienceStatus` 报告记忆服务的运行模式与降级情况。[领域声明](../../packages/experimental/memory-experience/src/domain.ts)定义存储字段，并在打开领域时校验这些字段。

服务将记录和命令限制在 Host 确定的作用域内。同一工作的选择保持固定；停用记录会在下一次模型请求前解除其使用。在报告运行时捕捉或检索故障后，普通执行可以在没有记忆的情况下继续。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxexperiencememory--experiencememory"></a>

### `ctx.experienceMemory` — `ExperienceMemory`

Local experimental memory; its storage writes precede every visible state update.

```ts cordis-catalog
/**
 * Await all capture, recovery, selection, and retirement operations already accepted.
 * @returns after the current owned queue has settled; failures are available in status.
 */
async flush(): Promise<void>

/**
 * Report local runtime state without querying Session history or invoking a model.
 * @returns current counts, configured mode, exhaustion flags, and the latest operation error.
 */
status(): ExperienceStatus

/**
 * List bounded experiences visible from an Agent's current host directory scope.
 * @param agent - receiving Agent; absent original project identity yields no records.
 * @returns stored active and retired records in the current scope, after pending writes settle.
 */
async list(agent: Agent): Promise<Episode[]>

/**
 * Inspect one same-scope source record, including its retirement tombstone.
 * @param agent - receiving Agent whose host directories authorize the read.
 * @param id - one opaque episode identity.
 * @returns the stored record, or absent for an unknown or other-scope identity.
 */
async inspect(agent: Agent, id: string): Promise<Episode | undefined>

/**
 * Retire a same-scope record atomically; later recovery can never overwrite the tombstone.
 * @param agent - receiving Agent whose host directories authorize the mutation.
 * @param id - one opaque episode identity.
 * @returns whether a visible record exists, after its retirement is durable.
 */
retire(agent: Agent, id: string): Promise<boolean>
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/memory-experience/src/index.ts`](../../packages/experimental/memory-experience/src/index.ts)
<!-- END GENERATED cordis-surface -->

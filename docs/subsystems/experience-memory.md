# Execution experience memory

English | [中文](experience-memory.zh.md)

The experimental [experience memory package](../../packages/experimental/memory-experience/README.md) captures completed execution intervals and selects scoped observations for a later job. Its package README owns configuration, capture rules, human commands, failure handling, and limitations. The [system-prompt reference](system-prompt.md) owns the current-only context retention used to present those observations.

## Records and status

An `Episode` retains a bounded request and concrete observations, with source Session and event references. Its outcome distinguishes observed failure and cancellation from an unverified completed interval; model self-report does not establish task success. `ExperienceStatus` reports the memory service's operating mode and degradation. The [domain declaration](../../packages/experimental/memory-experience/src/domain.ts) defines the stored fields and validates them when opening the domain.

The service restricts records and commands to the host-established scope. Selection remains fixed for a job; retiring a record removes its use before another model request. Ordinary execution can continue without memory after a reported runtime capture or retrieval failure.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md)

Source: [`packages/experimental/memory-experience/src/index.ts`](../../packages/experimental/memory-experience/src/index.ts)
<!-- END GENERATED cordis-surface -->

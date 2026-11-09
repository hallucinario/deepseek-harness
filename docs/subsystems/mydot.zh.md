# MyDot Space 与本地工作

[English](mydot.md) | 中文

可选的 [MyDot 插件](../../packages/experimental/mydot/README.zh.md) 拥有 Space 元数据、Session 关联、子任务投影、当前文件编辑及限定范围 Markdown 记忆。执行与持久化正本仍由现有 Session、Subagent、文件系统及 Schedule 服务所有。接收不代表消费或完成。桌面协调仅约束此 Host 中明确配置的工具，不宣称独立 OpenClaw 进程的控制权。

持续集成证据通过已审核的 `verificationChecks` 显式启用。独立的 `mydotEvidence` 能力读取已有 GitHub Actions 运行，绑定明确选定的子请求、条件版本和精确提交。带版本的插件记录保留在原始 Session 中，注册的投影将执行状态、验证结果和历史观察分开。实时证据必须通过现有 Session 写入器的持久化检查点后才可显示；冷读取无需激活即可重建已保存投影。工作流审核、支持的来源事件、显式刷新及失败行为由包 README 说明。

## `SpaceId`

```ts type-equiv
/** Opaque Space identity independent of a display name. */
type SpaceId = Branded<'MyDotSpaceId'>
```

## `Space`

```ts type-equiv
/** Durable small Space metadata. */
interface Space {
  id: SpaceId
  name: string
  purpose: string
  instructions: string
  materials: string[]
  workspaceId?: WorkspaceId | undefined
  archived: boolean
  revision: number
}
```

## `SpaceInput`

```ts type-equiv
/** New metadata or an optimistic replacement. */
type SpaceInput = Omit<Space, 'id' | 'revision' | 'archived'> & { id?: SpaceId; revision?: number; archived?: boolean }
```

## `StartJob`

```ts type-equiv
/** Local continuation creation, identified independently of its label. */
interface StartJob { parentSessionId: SessionId; requestId: SessionRequestId; label: string; prompt: string; provider: 'spawn' | 'fork' }
```

## `MemoryScope`

```ts type-equiv
/** Explicit memory isolation scope. */
type MemoryScope = { kind: 'personal' } | { kind: 'space'; spaceId: SpaceId }
```

## `DesktopState`

```ts type-equiv
/** State of one execution-world desktop, independent of file-only work. */
interface DesktopState { phase: 'free' | 'agent' | 'stopping' | 'human'; owner?: SessionId; capturedAt?: number; inFlight: number }
```

## `MyDotJobView`

```ts type-equiv
/** A job is an existing direct child, never another task record. */
interface MyDotJobView {
  parentSessionId: SessionId
  childSessionId: SessionId
  label: string
  mode: 'continuable' | 'one-shot' | 'external' | 'unknown'
  request?: string | undefined
  summary?: string | undefined
  status: 'running' | 'inactive'
  verification?: VerificationView
}
```

## `ArtifactView`

```ts type-equiv
/** Source coordinates and current file availability for a durable declaration. */
interface ArtifactView {
  sessionId: SessionId
  parentSessionId: SessionId
  path: string
  description?: string
  available: boolean
}
```

## `MyDotSnapshot`

```ts type-equiv
/** Lists are reconstructed; Space metadata and links use the MyDot storage domain. */
interface MyDotSnapshot {
  spaces: Space[]
  conversations: { sessionId: SessionId; spaceId: Space['id']; cwd: string }[]
  jobs: MyDotJobView[]
  artifacts: ArtifactView[]
  desktop: DesktopState
  desktopEnabled?: boolean
  verificationChecks?: VerificationCheck[]
  issues?: { sessionId: SessionId; kind: 'unavailable' | 'artifact-delivery' }[]
}
```

## `VerificationCheckId`

```ts type-equiv
/** Deployment-owned identity of one CI condition. */
type VerificationCheckId = Branded<'MyDotVerificationCheckId'>
```

## `VerificationCheck`

```ts type-equiv
/** Reviewed workflow whose push and merge-group source checkout and job semantics are known. */
interface VerificationCheck {
  /** Deployment-owned stable condition identifier. */
  id: VerificationCheckId
  /** GitHub repository in owner/name form. */
  repository: string
  /** Reviewed workflow path within .github/workflows. */
  workflowPath: string
  /** Git blob SHA of the reviewed workflow with an unmodified default source checkout. */
  workflowFileSha: string
  /** Exact job name whose conclusion constitutes this condition. */
  jobName: string
  /** User-visible explanation of what this condition establishes. */
  description: string
}
```

## `VerificationRequest`

```ts type-equiv
/** One local user message, independent of subsequent conversation turns. */
interface VerificationRequest { seq: SessionSeq; text: string }
```

## `VerificationTargetInput`

```ts type-equiv
/** User selection; conclusions are supplied only by the Host's CI reader. */
interface VerificationTargetInput { requestSeq: SessionSeq; checkId: VerificationCheckId; commit: string }
```

## `VerificationTarget`

```ts type-equiv
/** Immutable condition and request bound to a particular repository commit. */
interface VerificationTarget {
  seq: SessionSeq
  request: VerificationRequest
  commit: string
  check: VerificationCheck
  checkRevision: string
}
```

## `VerificationRun`

```ts type-equiv
/** GitHub's current workflow attempt, without claiming that a mutable worktree was tested. */
interface VerificationRun { id: number; attempt: number; url: string; commit: string; event: string }
```

## `VerificationJob`

```ts type-equiv
/** One exact CI job from the recorded workflow attempt. */
interface VerificationJob { id: number; url: string; name: string; conclusion: string | null }
```

## `VerificationReason`

```ts type-equiv
/** Stable reason codes displayed through the Client's locale dictionaries. */
type VerificationReason = 'condition-passed' | 'condition-failed' | 'job-not-completed' | 'job-not-passed'
  | 'job-missing' | 'job-ambiguous' | 'run-mismatch' | 'unsupported-event' | 'workflow-changed'
  | 'attempt-changed' | 'provider-unavailable' | 'invalid-response' | 'cancelled'
```

## `VerificationObservation`

```ts type-equiv
/** A persisted observation; an unsuccessful read is evidence of uncertainty, never success. */
interface VerificationObservation {
  seq: SessionSeq
  targetSeq: SessionSeq
  observedAt: number
  outcome: 'passed' | 'failed' | 'unavailable'
  reason: VerificationReason
  run?: VerificationRun | undefined
  job?: VerificationJob | undefined
}
```

## `VerificationHistory`

```ts type-equiv
/** A historical observation retains the original target even after selection changes. */
interface VerificationHistory { target: VerificationTarget; observation: VerificationObservation; current: boolean }
```

## `VerificationView`

```ts type-equiv
/** Projection consumed by MyDot; missing, invalid, and stale observations never pass. */
interface VerificationView {
  requests: VerificationRequest[]
  target: VerificationTarget | null
  status: 'unobserved' | 'passed' | 'failed' | 'unavailable'
  definitionCurrent: boolean
  history: VerificationHistory[]
  invalidRecords: boolean
}
```

## `TextRead`

```ts type-equiv
/** A current file read, with absence distinct from unreadability. */
type TextRead =
  | { kind: 'text'; path: string; content: string; version: FsVersion }
  | { kind: 'missing'; path: string }
```

## `TextSave`

```ts type-equiv
/** Full-file edit carrying the exact version the user observed. */
interface TextSave { path: string; content: string; version: FsVersion | null }
```

## `TextSaveResult`

```ts type-equiv
/** Conflict preserves both draft and current contents; no write occurred. */
type TextSaveResult =
  | { kind: 'saved'; path: string; version: FsVersion; content: string }
  | { kind: 'conflict'; path: string; draft: string; current: TextRead }
```

## `JobInput`

```ts type-equiv
/** Text routed to one exact continuable child. */
interface JobInput { parentSessionId: SessionId; childSessionId: SessionId; requestId: SubagentPromptRequestId; delivery: 'steer' | 'queue'; text: string }
```

## `JobAddress`

```ts type-equiv
/** Exact direct-parent ownership address. */
interface JobAddress { parentSessionId: SessionId; childSessionId: SessionId }
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmydot--mydotservice"></a>

### `ctx.mydot` — `MyDotService`

MyDot metadata, projected work and current-file access.

```ts cordis-catalog
/** Save observed Space metadata without mutating Session history or files.
 * @param input - New metadata or optimistic replacement.
 * @returns Committed Space.
 */
@Remote async saveSpace(input: SpaceInput): Promise<Space>

/** Start a fresh conversation in the Space's selected Workspace.
 * @param spaceId - Non-archived Space.
 * @returns New Session; association failure rejects without claiming a rollback of Session creation.
 */
@Remote async createConversation(spaceId: SpaceId): Promise<{ sessionId: SessionId }>

/** Bind an existing conversation once without changing its execution directory.
 * @param sessionId - Existing Session.
 * @param spaceId - Selected Space.
 */
@Remote async attach(sessionId: SessionId, spaceId: SpaceId): Promise<void>

/** Start a continuable local child under a stable caller-minted identity.
 * @param request - Exact parent and independently selected local provider.
 * @param signal - Caller cancellation before publication.
 * @returns Child identity; results are delivered through the existing parent channel.
 */
@Remote async startJob(request: StartJob, signal: AbortSignal): Promise<{ childSessionId: SessionId }>

/** Admit a targeted message using the existing durable deduplication key.
 * @param request - Exact address and stable request ID.
 * @param signal - Cancellation before admission.
 * @returns Existing inbox receipt; consumption remains observable in Session history.
 */
@Remote send(request: JobInput, signal: AbortSignal): Promise<SubagentPromptReceipt>

/** Request a child's cancellation while preserving pending input.
 * @param address - Exact direct parent and continuable child.
 * @returns Admission receipt, not a claim of completed stopping.
 */
@Remote stop(address: JobAddress): SubagentInterruptReceipt

/** Read source-linked current artifacts and existing child states without activating Sessions.
 * @returns Metadata and derived lists; missing files remain listed explicitly.
 */
@Remote async snapshot(): Promise<MyDotSnapshot>

/** Retry parent inbox presentation from the existing durable child declarations.
 * @param parentSessionId - Original live parent; cold parents must first be reopened.
 * @returns Resolution after the parent has accepted every missing reference.
 */
@Remote async presentResults(parentSessionId: SessionId): Promise<void>

/** Stream replacement snapshots over the existing Remote WebSocket carrier.
 * @param signal - Subscription cancellation, including reconnect/unload.
 * @returns Initial snapshot and subsequent committed metadata/execution changes.
 */
@Remote({ mode: 'stream' }) async *watch(signal: AbortSignal): AsyncIterable<MyDotSnapshot>

/** Read a referenced text file without capturing a fixed artifact version.
 * @param sessionId - Source conversation for path authorization.
 * @param path - Material, artifact or file within that Session's execution directory.
 * @returns Current content/version or explicit absence.
 */
@Remote async readFile(sessionId: SessionId, path: string): Promise<TextRead>

/** Persist a user edit atomically against its observed version.
 * @param sessionId - Source conversation.
 * @param request - Authorized file, draft and version.
 * @returns Saved version or retained conflict draft and current content.
 */
@Remote async saveFile(sessionId: SessionId, request: TextSave): Promise<TextSaveResult>

/** Queue continuation with the exact saved file/version recorded as user input.
 * @param sessionId - Source conversation receiving the follow-up.
 * @param path - Saved referenced file.
 * @param version - Version confirmed by the editor.
 * @param requestId - Stable caller-minted inbox identity.
 * @param signal - Cancellation before inbox admission.
 * @returns Existing Session prompt receipt.
 */
@Remote async continueFile( sessionId: SessionId, path: string, version: FsVersion, requestId: SessionRequestId, signal: AbortSignal, ): Promise<SessionPromptValue>

/** Read scoped Markdown memory with its source path.
 * @param scope - Personal or one exact Space.
 * @returns Editable current source, distinct from execution-experience memory.
 */
@Remote async readMemory(scope: MemoryScope): Promise<TextRead>

/** Save one memory source with the same optimistic edit semantics as documents.
 * @param scope - Personal or one exact Space.
 * @param request - Draft and observed version; path is chosen by the Host.
 * @returns Saved version or current content and retained draft.
 */
@Remote async saveMemory(scope: MemoryScope, request: Omit<TextSave, 'path'>): Promise<TextSaveResult>

/** Stop new desktop tool admission before allowing the person to edit.
 * @returns Stopping until admitted tool bodies settle, then human ownership.
 */
@Remote handoffDesktop(): DesktopState

/** Resume only against a newly captured frame after human ownership.
 * @param owner - Original controlling Session.
 * @param capturedAt - Exact new observation timestamp.
 * @returns Agent ownership; no desktop action is launched by this method.
 */
@Remote resumeDesktop(owner: SessionId, capturedAt: number): DesktopState

/** Release a quiescent desktop so the next waiting job can own it.
 * @param owner - Exact current agent owner.
 * @returns New ownership state; human handoff cannot be bypassed.
 */
@Remote releaseDesktop(owner: SessionId): DesktopState
```

Types: [FsVersion](filesystem.zh.md) · [SessionId](core.zh.md) · [SessionPromptValue](session.zh.md) · [SessionRequestId](session.zh.md) · [SubagentInterruptReceipt](subagent.zh.md) · [SubagentPromptReceipt](subagent.zh.md)

Source: [`packages/experimental/mydot/src/index.ts`](../../packages/experimental/mydot/src/index.ts)

<a id="ctxmydotevidence--mydotevidence"></a>

### `ctx.mydotEvidence` — `MyDotEvidence`

User-triggered CI reads; never starts a model turn, test, retry, or external write.

```ts cordis-catalog
/** Publish only evidence that reached the existing Session durability checkpoint.
 * @param source - One exact live or persisted projection cut from SessionQuery.
 * @returns Current evidence; failed checkpoints retain only the acknowledged prefix.
 */
async view(source: SessionObservation): Promise<VerificationView>

/** Bind a local request and configured condition to an exact commit.
 * @param sessionId - Live or stored source Session whose own user message is selected.
 * @param input - Request position, condition identity and full commit SHA.
 * @returns The persisted immutable selection; selecting it again is idempotent.
 */
@Remote({ resources: { session: sessionId => sessionId } }) async setTarget(sessionId: SessionId, input: VerificationTargetInput): Promise<VerificationTarget>

/** Record an existing GitHub run for the caller's exact, still-selected target.
 * @param sessionId - Live or stored source Session; no Agent activation is required.
 * @param targetSeq - Selection observed by the caller; stale selections reject before I/O.
 * @param runId - Existing positive GitHub Actions run ID.
 * @param signal - Caller cancellation, combined with plugin disposal and deployment deadline.
 * @returns After the observation is durable; a newer target keeps this result as history.
 */
@Remote({ resources: { session: sessionId => sessionId } }) async refresh(sessionId: SessionId, targetSeq: SessionSeq, runId: number, signal: AbortSignal): Promise<void>
```

Types: [SessionId](core.zh.md) · [SessionObservation](session-query.zh.md) · [SessionSeq](session.zh.md)

Source: [`packages/experimental/mydot/src/verification.ts`](../../packages/experimental/mydot/src/verification.ts)
<!-- END GENERATED cordis-surface -->

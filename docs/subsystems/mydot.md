# MyDot Spaces and local work

English | [中文](mydot.zh.md)

The opt-in [MyDot package](../../packages/experimental/mydot/README.md) owns Space metadata, Session associations, projected child work, current-file editing and scoped Markdown memory. Existing Session, Subagent, filesystem and Schedule services retain execution and persistence authority. Receipts do not establish consumption or completion. Desktop coordination applies only to explicitly configured tools in this Host; it does not claim ownership of an independent OpenClaw process.

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
/** All lists are reconstructed; only Space metadata and Session links are new storage. */
interface MyDotSnapshot {
  spaces: Space[]
  conversations: { sessionId: SessionId; spaceId: Space['id']; cwd: string }[]
  jobs: MyDotJobView[]
  artifacts: ArtifactView[]
  desktop: DesktopState
  desktopEnabled?: boolean
  humanRequests?: readonly HumanRequestView[] | undefined
  issues?: { sessionId: SessionId; kind: 'unavailable' | 'artifact-delivery' }[]
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

## `HumanRequestId`

```ts type-equiv
/** Opaque identity of one durable request, independent of its label or Session. */
type HumanRequestId = Branded<'MyDotHumanRequestId'>
```

## `HumanSubmissionId`

```ts type-equiv
/** Stable identity retained when an answer response is lost. */
type HumanSubmissionId = Branded<'MyDotHumanSubmissionId'>
```

## `HumanSurveyTarget`

```ts type-equiv
/** Immutable survey source and exact starting edit revision. */
interface HumanSurveyTarget {
  caseId: string
  sourceId: string
  sourceRevision: string
  baseRevisionId: string
  baseVersion: number
  workflow: 'independent-reference' | 'assisted-correction'
}
```

## `SurveyHandoffResult`

```ts type-equiv
/** Reference returned by the survey server; drawing contents stay in that application. */
interface SurveyHandoffResult {
  schemaVersion: 1
  requestId: HumanRequestId
  status: 'saved' | 'applied' | 'deferred' | 'needs-material'
  source: { caseId: string; sourceId: string; sourceRevision: string; manifestId: string }
  baseSurvey: { revisionId: string; version: number }
  survey: { revisionId: string; version: number }
  planning: null | { caseId: string; revisionId: string; headVersion: number }
  goldId: string | null
}
```

## `PreparedHumanRequest`

```ts type-equiv
/** Prepared request bound to one original branch and observed source version. */
interface PreparedHumanRequest {
  requestId: HumanRequestId
  requestRevision: number
  sessionId: SessionId
  parentSessionId: SessionId | null
  question: string
  reason: string
  role: 'owner'
  evidenceUrl: string
  resumeInstruction: string
  options: string[]
  target: HumanSurveyTarget | null
  goal: { id: string; revision: number; roundsStarted: number; armed: boolean } | null
}
```

## `HumanAnswer`

```ts type-equiv
/** Explicit response; its meaning never expands external-action permission. */
interface HumanAnswer {
  requestId: HumanRequestId
  requestRevision: number
  submissionId: HumanSubmissionId
  choice: string
  text: string
  result: SurveyHandoffResult | null
}
```

## `HumanRequestView`

```ts type-equiv
/** Receipt, model admission and actual outcome are distinct durable facts. */
interface HumanRequestView {
  request: PreparedHumanRequest
  phase: 'pending' | 'received' | 'dispatching' | 'queued' | 'claimed' | 'resumed' | 'stopped' | 'retired' | 'outcome'
  answer?: HumanAnswer | undefined
  rpcId?: string | undefined
  reason?: string | undefined
  outcome?: 'succeeded' | 'failed' | 'unknown' | undefined
  evidence?: string | undefined
}
```

## `HumanRequestChange`

```ts type-equiv
/** Changes belong to the original Session's single append-only writer. */
type HumanRequestChange =
  | { kind: 'prepared'; request: PreparedHumanRequest }
  | { kind: 'received'; requestId: HumanRequestId; answer: HumanAnswer; responder: string }
  | { kind: 'dispatching'; requestId: HumanRequestId; rpcId: string }
  | { kind: 'queued' | 'claimed' | 'resumed'; requestId: HumanRequestId }
  | { kind: 'stopped'; requestId: HumanRequestId; reason: string }
  | { kind: 'retired'; requestId: HumanRequestId; reason: string }
  | { kind: 'outcome'; requestId: HumanRequestId; outcome: 'succeeded' | 'failed' | 'unknown'; evidence: string }
```

## `PrepareHumanInput`

```ts type-equiv
/** Model preparation fields; Session ownership and goal state come from the Host. */
interface PrepareHumanInput {
  requestId: string
  question: string
  reason: string
  evidenceUrl: string
  resumeInstruction: string
  options: string[]
  target: HumanSurveyTarget | null
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [FsVersion](filesystem.md) · [SessionId](core.md) · [SessionPromptValue](session.md) · [SessionRequestId](session.md) · [SubagentInterruptReceipt](subagent.md) · [SubagentPromptReceipt](subagent.md)

Source: [`packages/experimental/mydot/src/index.ts`](../../packages/experimental/mydot/src/index.ts)

<a id="ctxmydothandoff--humanhandoffservice"></a>

### `ctx.mydotHandoff` — `HumanHandoffService`

Concrete answer/recovery methods backed by the existing parent Session writer.

```ts cordis-catalog
/** Prepare one human dependency and disarm only its original branch.
 * @param agent - Actual initiating branch, never a model-selected Session.
 * @param input - Versioned question and evidence prepared for the owner.
 * @returns Persisted pending request.
 */
async prepare(agent: Agent, input: PrepareHumanInput): Promise<HumanRequestView>

/** Accept an owner response; a receipt does not certify subsequent work.
 * @param input - Stable submission and exact observed request revision.
 * @returns Current durable receipt or correlated execution state.
 */
@Remote async answer(input: HumanAnswer): Promise<HumanRequestView>

/** Reconcile a saved external result or an accepted but undelivered answer.
 * @param requestId - Exact durable request identity.
 * @returns Saved state, including explicit refusal or uncertainty.
 */
@Remote async reconcile(requestId: HumanRequestId): Promise<HumanRequestView>

/** Retire a dependency without replaying or changing its saved answer.
 * @param requestId - Exact request the owner is cancelling.
 * @returns Durable retired state; no external action or model turn is started.
 */
@Remote async cancel(requestId: HumanRequestId): Promise<HumanRequestView>

/** Read the canonical projected request list without holding a model or a browser.
 * @returns Current request states reconstructed from Session projections.
 */
async snapshot(): Promise<readonly HumanRequestView[]>
```

Types: [Agent](core.md)

Source: [`packages/experimental/mydot/src/human-handoff.ts`](../../packages/experimental/mydot/src/human-handoff.ts)

<a id="mydot-events"></a>

### `mydot/*` events

<a id="mydothandoff-changed--emit"></a>

#### `mydot/handoff-changed` — emit

Committed request state changed. @mode emit

```ts cordis-catalog
/** Committed request state changed. @mode emit */
'mydot/handoff-changed'(): void
```

Source: [`packages/experimental/mydot/src/human-handoff.ts`](../../packages/experimental/mydot/src/human-handoff.ts)
<!-- END GENERATED cordis-surface -->

/** Instance-owned desktop handoff state; execution wrappers supply the quiescence evidence. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

import type { DesktopState } from './types.ts'
export type { DesktopState } from './types.ts'

/** One physical desktop has one owner across observation, action and verification. */
export class DesktopOwnership {
  private state: DesktopState = { phase: 'free', inFlight: 0 }
  private captureGeneration = 0
  private handoffGeneration = 0
  private readonly changed = new Set<() => void>()

  /** Read current coordination state.
   * @returns Immutable snapshot replaced on every change.
   */
  snapshot(): DesktopState { return this.state }

  /** Claim the desktop for a job; file-only jobs never call this method.
   * @param owner - Exact controlling Session.
   */
  claim(owner: SessionId): void {
    if (this.state.phase !== 'free' && this.state.owner !== owner) throw new Error('Desktop is owned by another job')
    if (this.state.phase === 'human' || this.state.phase === 'stopping') throw new Error('Desktop is stopping or held by a person')
    this.state = { ...this.state, owner, phase: 'agent' }
  }

  /** Admit a tool body under the sole owner.
   * @param owner - Exact controlling Session.
   * @returns Idempotent completion callback for the admitted operation.
   */
  begin(owner: SessionId): () => void {
    this.claim(owner)
    if (this.state.inFlight !== 0) throw new Error('Desktop operation is still active')
    this.state = { ...this.state, inFlight: this.state.inFlight + 1 }
    return this.completion()
  }

  private completion(): () => void {
    let finished = false
    return () => {
      if (finished) return
      finished = true
      const inFlight = this.state.inFlight - 1
      this.state = { ...this.state, inFlight, phase: this.state.phase === 'stopping' && inFlight === 0 ? 'human' : this.state.phase }
      this.notify()
    }
  }

  /** Wait for one admitted desktop body without holding file-only work.
   * @param owner - Exact controlling Session.
   * @param signal - Owning tool's cancellation, also closing a waiting call.
   * @param capture - A configured read-only capture can observe human changes.
   * @returns Completion callback; ownership remains until explicit release.
   */
  async acquire(owner: SessionId, signal: AbortSignal, capture = false): Promise<() => void> {
    while (true) {
      signal.throwIfAborted()
      if (this.state.inFlight === 0) {
        if (capture && this.state.phase === 'human' && this.state.owner === owner) {
          this.state = { ...this.state, inFlight: 1 }
          return this.completion()
        }
        if (this.state.phase === 'free' || (this.state.phase === 'agent' && this.state.owner === owner)) return this.begin(owner)
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => { this.changed.delete(wake); signal.removeEventListener('abort', abort) }
        const wake = (): void => { cleanup(); resolve() }
        const abort = (): void => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error('Desktop admission cancelled', { cause: signal.reason })) }
        this.changed.add(wake)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
  }

  /** Release a quiescent agent owner so another queued desktop job may start.
   * @param owner - Current owner, never a person holding the desktop.
   */
  release(owner: SessionId): void {
    if (this.state.owner !== owner || this.state.phase !== 'agent' || this.state.inFlight !== 0) throw new Error('Finish desktop operations before release')
    this.state = { phase: 'free', inFlight: 0 }
    this.notify()
  }

  private notify(): void { for (const listener of [...this.changed]) listener() }

  /** Close admission before waiting for already admitted tools.
   * @returns Stopping until tools finish, then confirmed human ownership.
   */
  requestHandoff(): DesktopState {
    this.handoffGeneration = this.captureGeneration
    this.state = { ...this.state, phase: this.state.inFlight === 0 ? 'human' : 'stopping' }
    return this.state
  }

  /** Record a successfully completed fresh capture, never just a requested capture.
   * @param capturedAt - Actual observation time.
   */
  observed(capturedAt: number): void {
    this.captureGeneration += 1
    this.state = { ...this.state, capturedAt }
  }

  /** Resume only after a capture made after the handoff request.
   * @param owner - Session receiving ownership again.
   * @param capturedAt - Exact newly observed frame selected for resume.
   * @returns Agent ownership with the fresh observation time.
   */
  resume(owner: SessionId, capturedAt: number): DesktopState {
    if (this.state.inFlight !== 0 || this.state.phase !== 'human' || this.captureGeneration <= this.handoffGeneration || capturedAt !== this.state.capturedAt) {
      throw new Error('A fresh desktop capture is required before resume')
    }
    if (this.state.owner !== undefined && this.state.owner !== owner) throw new Error('Desktop is owned by another job')
    this.state = { ...this.state, phase: 'agent', owner }
    return this.state
  }
}

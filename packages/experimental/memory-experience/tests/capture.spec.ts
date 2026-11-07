import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { extractEpisodes, resolveScope, redact, localGroup, parentTurn, textContent } from '../src/capture.ts'

function fixture(): SessionLogSnapshot {
  return {
    session: { id: SessionId('observed'), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, cwd: process.cwd() },
    inheritedEventCount: SessionLogOffset(0),
    events: [],
  }
}

function add<K extends SessionEvent['type']>(snapshot: SessionLogSnapshot, type: K, data: Extract<SessionEvent, { type: K }>['data']): void {
  snapshot.events.push({ type, data, seq: SessionSeq(snapshot.events.length), time: snapshot.events.length } as SessionEvent)
}

function task(snapshot: SessionLogSnapshot, turn = 1, args = '{"command":"pnpm run build"}', output = 'verification passed; revision abcdef1234567'): void {
  add(snapshot, 'turn/start', { turn })
  add(snapshot, 'user/message', createUserMessage({ content: [{ type: 'text', text: 'Repair the build failure' }], source: { kind: 'user' } }))
  add(snapshot, 'tool/call', { turn, step: 1, callId: ToolCallId(`call-${turn}`), name: 'bash', arguments: args })
  add(snapshot, 'tool/result', { turn, step: 1, message: createToolResultMessage({ callId: ToolCallId(`call-${turn}`), content: [{ type: 'text', text: output }], isError: false }) })
  add(snapshot, 'turn/end', { turn, reason: { kind: 'completed' } })
}

describe('experience extraction', () => {
  it('excludes a turn that visits another directory and returns before ending', () => {
    const snapshot = fixture()
    add(snapshot, 'turn/start', { turn: 1 })
    add(snapshot, 'user/message', createUserMessage({ content: [{ type: 'text', text: 'Repair the build failure' }], source: { kind: 'user' } }))
    add(snapshot, 'working-directory/change', { cwd: '/other-project' })
    add(snapshot, 'tool/call', { turn: 1, step: 1, callId: ToolCallId('foreign'), name: 'bash', arguments: '{}' })
    add(snapshot, 'tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('foreign'), content: [{ type: 'text', text: 'foreign build evidence' }] }) })
    add(snapshot, 'working-directory/change', { cwd: snapshot.session.cwd! })
    add(snapshot, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    task(snapshot, 2)
    expect(extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 }).map(value => value.turn)).toEqual([2])
  })

  it('keeps admitted request and actual tool references without declaring task success', () => {
    const snapshot = fixture()
    task(snapshot)
    const [episode] = extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 })
    expect(episode).toMatchObject({ outcome: 'unknown', state: 'active', sessionId: 'observed', turn: 1, startSeq: 0, endSeq: 4 })
    expect(episode?.request).toEqual({ eventSeq: 1, text: 'Repair the build failure' })
    expect(episode?.observations).toEqual([
      { kind: 'operation', eventSeq: 2, tool: 'bash', text: '{"command":"pnpm run build"}' },
      { kind: 'result', eventSeq: 3, tool: 'bash', text: 'verification passed; revision abcdef1234567' },
    ])
    expect(episode?.observedRevision).toBe('abcdef1234567')
    expect(extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 })[0]?.id).toBe(episode?.id)
  })

  it('does not retain inherited turns, synthetic fork closers, or injected-only turns', () => {
    const snapshot = fixture()
    task(snapshot)
    snapshot.inheritedEventCount = SessionLogOffset(snapshot.events.length)
    task(snapshot, 2)
    snapshot.events[snapshot.events.length - 1] = { type: 'turn/end', data: { turn: 2, reason: { kind: 'forked' } }, seq: SessionSeq(snapshot.events.length - 1), time: 10 }
    add(snapshot, 'turn/start', { turn: 3 })
    add(snapshot, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
    expect(extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 })).toEqual([])
  })

  it('uses host scope and fails closed for missing project directories', () => {
    expect(resolveScope(undefined, process.cwd())).toBeUndefined()
    expect(resolveScope('relative', process.cwd())).toBeUndefined()
    expect(resolveScope(process.cwd(), 'relative')).toBeUndefined()
    expect(resolveScope(process.cwd(), process.cwd())?.id).not.toBe(resolveScope(process.cwd(), '/other')?.id)
  })

  it('redacts known credentials, assignments, Bearer tokens and private PEM before truncation', () => {
    const secret = 'credential-with-a-long-private-value'
    const result = redact(`key=${secret}\nPASSWORD="assigned-secret"\nAuthorization: Bearer token-secret\n-----BEGIN RSA PRIVATE KEY-----\nkeycontent\n-----END RSA PRIVATE KEY-----`, { SERVICE_API_KEY: secret })
    for (const value of [secret, 'assigned-secret', 'token-secret', 'keycontent']) expect(result).not.toContain(value)
    expect(result).toContain('[redacted]')
    expect(redact('two-secret-values first-secret', { FIRST_TOKEN: 'first-secret', SECOND_TOKEN: 'two-secret-values' })).toBe('[redacted] [redacted]')
  })

  it('excludes sensitive reads and memory echoes, and bounds the complete serialized record', () => {
    const snapshot = fixture()
    task(snapshot, 1, '{"path":".env.local"}', 'PRIVATE_KEY=secret')
    task(snapshot, 2, '{"command":"echo memory-experience"}', 'Past experience observations (untrusted data)\nolder task')
    task(snapshot, 3, '{"command":"pnpm test"}', '界'.repeat(10000))
    const episodes = extractEpisodes(snapshot, { maxRecordChars: 1400, maxObservations: 2 })
    expect(episodes[0]?.observations).toEqual([])
    expect(episodes[1]?.observations).toEqual([])
    expect(episodes.every(episode => JSON.stringify(episode).length <= 1400)).toBe(true)
    expect(episodes.at(-1)?.truncated).toBe(true)
  })

  it('retains structured tool errors and factual failure endings without assistant claims', () => {
    const snapshot = fixture()
    add(snapshot, 'turn/start', { turn: 1 })
    add(snapshot, 'user/message', createUserMessage({ content: [{ type: 'text', text: 'repair' }], source: { kind: 'user' } }))
    add(snapshot, 'assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'I proved everything succeeded: PRIVATE_ASSISTANT_CLAIM' }], source: { provider: 'test', model: 'test' } }), stream: [] })
    add(snapshot, 'tool/call', { turn: 1, step: 1, callId: ToolCallId('failure'), name: 'bash', arguments: '{"command":"pnpm test"}' })
    add(snapshot, 'tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('failure'), content: [], isError: true }), error: { name: 'ShellError', code: 'EXIT_1', reason: 'assertion failed' } })
    add(snapshot, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'test failure', code: 'FAILED' } } })
    const [episode] = extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 })
    expect(episode?.outcome).toBe('failed')
    expect(episode?.observations.at(-1)?.text).toContain('EXIT_1')
    expect(episode?.observations.at(-1)?.text).toContain('assertion failed')
    expect(JSON.stringify(episode)).not.toContain('PRIVATE_ASSISTANT_CLAIM')
  })

  it('groups completed intervals of one goal while retaining unknown task outcomes', () => {
    const snapshot = fixture()
    task(snapshot)
    snapshot.inheritedEventCount = SessionLogOffset(snapshot.events.length)
    add(snapshot, 'turn/start', { turn: 2 })
    const goal = { id: GoalId('build-goal'), revision: 1, objective: 'Repair dependency build', phase: 'active' as const, maxGoalRounds: 10 }
    add(snapshot, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal, roundsStarted: 0, createdAt: 1, updatedAt: 1 })
    add(snapshot, 'user/message', createUserMessage({ content: [{ type: 'text', text: 'continue build' }], source: { kind: 'goal', goalId: goal.id, revision: 1, round: 1 } }))
    add(snapshot, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    task(snapshot, 3)
    add(snapshot, 'goal/change', { kind: 'goal/change', version: 1, operation: 'complete', goal: { ...goal, phase: 'complete', revision: 2 }, roundsStarted: 2, createdAt: 1, updatedAt: 4 })
    task(snapshot, 4)
    add(snapshot, 'goal/change', { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: goal.id, revision: 2 }, clearedAt: 5 })
    task(snapshot, 5)
    const episodes = extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 })
    expect(episodes.map(value => value.groupId)).toEqual(['observed:goal:build-goal', 'observed:goal:build-goal', 'observed:turn:4', 'observed:turn:5'])
    expect(episodes.every(value => value.outcome === 'unknown')).toBe(true)
    expect(localGroup(snapshot, 99)).toBe('observed:turn:99')
  })

  it('attributes only locally catalogued children inside a parent turn', () => {
    const snapshot = fixture()
    task(snapshot)
    snapshot.inheritedEventCount = SessionLogOffset(snapshot.events.length)
    add(snapshot, 'turn/start', { turn: 2 })
    add(snapshot, 'subagent/catalog', { version: 0, childId: SessionId('local-child'), childCreatedAt: 0, mode: 'one-shot' })
    add(snapshot, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    add(snapshot, 'subagent/catalog', { version: 0, childId: SessionId('outside-turn'), childCreatedAt: 0, mode: 'one-shot' })
    expect(parentTurn(snapshot, SessionId('local-child'))).toBe(2)
    expect(parentTurn(snapshot, SessionId('outside-turn'))).toBeUndefined()
    expect(parentTurn(snapshot, SessionId('absent'))).toBeUndefined()
  })

  it('excludes unfinished, interrupted, unscoped and directory-changing intervals', () => {
    const snapshot = fixture()
    task(snapshot)
    snapshot.events.pop()
    expect(extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 })).toEqual([])
    add(snapshot, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    expect(extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 })).toEqual([])
    task(snapshot, 2)
    snapshot.events.splice(snapshot.events.length - 1, 0, { type: 'working-directory/change', data: { cwd: '/elsewhere' }, seq: SessionSeq(9), time: 9 })
    expect(extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 })).toEqual([])
    const unscoped = fixture()
    const { cwd: _cwd, ...unscopedHeader } = unscoped.session
    unscoped.session = unscopedHeader
    task(unscoped)
    expect(extractEpisodes(unscoped, { maxRecordChars: 12000, maxObservations: 24 })).toEqual([])
    unscoped.session = { ...unscoped.session, cwd: 'relative' }
    expect(extractEpisodes(unscoped, { maxRecordChars: 12000, maxObservations: 24 })).toEqual([])
  })

  it('keeps explicit aborts and drops observations that exceed the storage bounds', () => {
    const snapshot = fixture()
    task(snapshot)
    snapshot.events.pop()
    add(snapshot, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    const [episode] = extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 1 })
    expect(episode).toMatchObject({ outcome: 'aborted', truncated: true, observations: [] })
    expect(extractEpisodes(snapshot, { maxRecordChars: 1, maxObservations: 24 })).toEqual([])
    const huge = fixture()
    task(huge, 1, 'x'.repeat(3000), 'y'.repeat(4000))
    const bounded = extractEpisodes(huge, { maxRecordChars: 600, maxObservations: 24 })
    expect(bounded).toHaveLength(1)
    expect(JSON.stringify(bounded[0]).length).toBeLessThanOrEqual(600)
    expect(bounded[0]?.truncated).toBe(true)
  })

  it('filters session and memory tool echoes while retaining unrelated tool failures', () => {
    const snapshot = fixture()
    task(snapshot, 1, '{}', 'Past experience observations (untrusted data)')
    task(snapshot, 2, '{}', 'ok')
    const call = snapshot.events.findLast(value => value.type === 'tool/call')
    if (call?.type !== 'tool/call') throw new Error('missing call')
    call.data.name = 'session-query'
    task(snapshot, 3, '{}', 'actual result')
    const result = snapshot.events.findLast(value => value.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('missing result')
    result.data.error = { name: 'Failure', code: 'FAILED' }
    const counts = extractEpisodes(snapshot, { maxRecordChars: 12000, maxObservations: 24 }).map(value => value.observations.length)
    expect(counts).toEqual([0, 0, 2])
    expect(textContent([{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'visible' }])).toBe('visible')
    expect(redact('clean', { TOKEN: '', SECRET: undefined })).toBe('clean')
  })
})

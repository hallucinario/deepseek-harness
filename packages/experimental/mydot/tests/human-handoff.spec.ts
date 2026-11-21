/** Durable request replay and target association, independent of live browser state. */
import { expect, it } from 'vitest'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { applyHumanRequestEvent, humanAnswerSchema, humanRequestSchema, surveyResultSchema } from '../src/human-handoff-state.ts'
import type { HumanRequestView } from '../src/types.ts'

const request = humanRequestSchema.parse({
  requestId: 'review-1', requestRevision: 1, sessionId: SessionId('original'), parentSessionId: null,
  question: 'Confirm the visible dimensions', reason: 'The original drawing needs an independent reference',
  role: 'owner' as const, evidenceUrl: 'https://example.test/survey', resumeInstruction: 'Re-evaluate the saved revision',
  options: ['confirmed'], target: null, goal: null,
})
function event(type: SessionEvent['type'], data: SessionEvent['data']): SessionEvent {
  return { type, data, seq: SessionSeq(1), time: 1 } as SessionEvent
}
const change = (data: SessionEvent<'mydot/human-handoff'>['data']) => event('mydot/human-handoff', data)

it('keeps received, claimed, resumed and outcome distinct when replaying a request', () => {
  let state: readonly HumanRequestView[] = []
  state = applyHumanRequestEvent(state, change({ kind: 'prepared', request }))
  const answer = humanAnswerSchema.parse({ requestId: 'review-1', requestRevision: 1, submissionId: 'stable', choice: 'confirmed', text: '', result: null })
  state = applyHumanRequestEvent(state, change({ kind: 'received', requestId: request.requestId, answer, responder: 'host-owner' }))
  expect(state[0]?.phase).toBe('received')
  state = applyHumanRequestEvent(state, event('turn/end', { turn: 1 }))
  expect(state[0]?.phase).toBe('received')
  state = applyHumanRequestEvent(state, change({ kind: 'dispatching', requestId: request.requestId, rpcId: 'handoff:review-1:1' }))
  state = applyHumanRequestEvent(state, change({ kind: 'claimed', requestId: request.requestId }))
  expect(state[0]?.phase).toBe('claimed')
  const unrelated = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'other work' }] })
  state = applyHumanRequestEvent(state, event('user/message', unrelated))
  expect(state[0]?.phase).toBe('claimed')
  const replied = createUserMessage({ source: { kind: 'user', rpcId: 'handoff:review-1:1' }, content: [{ type: 'text', text: 'answer' }] })
  state = applyHumanRequestEvent(state, event('user/message', replied))
  expect(state[0]?.phase).toBe('resumed')
  state = applyHumanRequestEvent(state, change({ kind: 'outcome', requestId: request.requestId, outcome: 'succeeded', evidence: 'artifacts/report.md' }))
  expect(state[0]).toMatchObject({ phase: 'outcome', outcome: 'succeeded', evidence: 'artifacts/report.md' })
})

it('validates persisted request versions and refuses credential-bearing evidence links', () => {
  expect(humanRequestSchema.parse(request)).toEqual(request)
  expect(() => humanRequestSchema.parse({ ...request, requestRevision: 0 })).toThrow()
  expect(() => humanRequestSchema.parse({ ...request, evidenceUrl: 'https://user:secret@example.test/' })).toThrow()
  expect(() => humanRequestSchema.parse({ ...request, evidenceUrl: 'javascript:alert(1)' })).toThrow()
  expect(() => humanRequestSchema.parse({ ...request, evidenceUrl: 'not a URL' })).toThrow()
  expect(() => humanRequestSchema.parse({ ...request, requestId: 'bad.id' })).toThrow()
  expect(() => humanRequestSchema.parse({ ...request, evidenceUrl: 'https://example.test/?token=secret' })).toThrow()
})

it('keeps retirement and outcome final when delayed admission and queue events arrive', () => {
  const other = humanRequestSchema.parse({ ...request, requestId: 'other-review' })
  let state = applyHumanRequestEvent([], change({ kind: 'prepared', request }))
  state = applyHumanRequestEvent(state, change({ kind: 'prepared', request: other }))
  state = applyHumanRequestEvent(state, change({ kind: 'dispatching', requestId: request.requestId, rpcId: 'handoff:review-1:1' }))
  state = applyHumanRequestEvent(state, change({ kind: 'queued', requestId: request.requestId }))
  expect(state[0]?.phase).toBe('queued')
  state = applyHumanRequestEvent(state, change({ kind: 'claimed', requestId: request.requestId }))
  state = applyHumanRequestEvent(state, change({ kind: 'queued', requestId: request.requestId }))
  expect(state[0]?.phase).toBe('claimed')
  state = applyHumanRequestEvent(state, change({ kind: 'resumed', requestId: request.requestId }))
  state = applyHumanRequestEvent(state, change({ kind: 'claimed', requestId: request.requestId }))
  state = applyHumanRequestEvent(state, change({ kind: 'queued', requestId: request.requestId }))
  expect(state[0]?.phase).toBe('resumed')
  state = applyHumanRequestEvent(state, change({ kind: 'stopped', requestId: request.requestId, reason: 'Unknown delivery' }))
  state = applyHumanRequestEvent(state, change({ kind: 'queued', requestId: request.requestId }))
  state = applyHumanRequestEvent(state, change({ kind: 'claimed', requestId: request.requestId }))
  expect(state[0]?.phase).toBe('stopped')
  state = applyHumanRequestEvent(state, change({ kind: 'retired', requestId: request.requestId, reason: 'Owner cancelled' }))
  for (const late of [change({ kind: 'claimed', requestId: request.requestId }), change({ kind: 'queued', requestId: request.requestId }), change({ kind: 'resumed', requestId: request.requestId }),
    event('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'handoff:review-1:1' }, content: [] }))]) {
    state = applyHumanRequestEvent(state, late)
    expect(state[0]?.phase).toBe('retired')
  }
  expect(state[1]?.phase).toBe('pending')
})

it('validates an exact survey result instead of treating arbitrary references as completion', () => {
  const result = { schemaVersion: 1, requestId: 'review-1', status: 'saved',
    source: { caseId: 'case-1', sourceId: 'source-1', sourceRevision: 'a'.repeat(64), manifestId: 'b'.repeat(64) },
    baseSurvey: { revisionId: 'c'.repeat(64), version: 1 }, survey: { revisionId: 'd'.repeat(64), version: 2 }, planning: null, goldId: null }
  expect(surveyResultSchema.parse(result)).toEqual(result)
  expect(() => surveyResultSchema.parse({ ...result, schemaVersion: 2 })).toThrow()
  expect(() => surveyResultSchema.parse({ ...result, survey: { revisionId: 'd'.repeat(64), version: -1 } })).toThrow()
})

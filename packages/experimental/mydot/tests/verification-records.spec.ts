/** Requests, immutable condition revisions, historical results and restoration. */
import { expect, it } from 'vitest'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { appendPluginRecord, createPluginRecord, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { foldVerification, verificationProjection, verificationView, verificationCheckRevision } from '../src/verification-records.ts'
import { check, commit } from './verification-fixture.ts'

function setup() {
  const session = Session.create(SessionId('job-a'))
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'MyDot job request: {"prompt":"Fix the parser"}' }] }), { surfaceOp: 'append' })
  return session
}
function selected(session: Session, sha = commit, requestSeq = SessionSeq(0)) {
  return appendPluginRecord(session, 'plugin:mydot/verification-target', { version: 1,
    request: { seq: requestSeq, text: requestSeq === 0 ? 'Fix the parser' : 'Different request' }, commit: sha, check, checkRevision: verificationCheckRevision(check) })
}
function passed(session: Session, targetSeq: SessionSeq) {
  appendPluginRecord(session, 'plugin:mydot/verification-observation', observed(targetSeq))
}
function observed(targetSeq: SessionSeq) {
  return { version: 1 as const, targetSeq, observedAt: 123,
    outcome: 'passed' as const, reason: 'condition-passed' as const, run: { id: 123, attempt: 2, event: 'push', commit,
      url: 'https://github.com/owner/repo/actions/runs/123/attempts/2' },
    job: { id: 456, name: check.jobName, conclusion: 'success', url: 'https://github.com/owner/repo/actions/runs/123/job/456' } }
}
function stored(session: Session, type: 'plugin:mydot/verification-target' | 'plugin:mydot/verification-observation', data: unknown) {
  // @ts-expect-error -- simulate persisted JSON from an incompatible or damaged plugin version.
  appendPluginRecord(session, type, data)
}
function state(session: Session, inherited = SessionLogOffset(0)) {
  return session.snapshotEvents().reduce(foldVerification, verificationProjection.init(session.header, inherited))
}

it('keeps no observation distinct from model completion and file availability', () => {
  const session = setup()
  selected(session)
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createAssistantMessage({
    source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'All tests passed; done.' }],
  }) }, { surfaceOp: 'append' })
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'unobserved', history: [], requests: [{ seq: 0, text: 'Fix the parser' }] })
})

it('restores the same observation, keeps unrelated chat, and invalidates selected commit or condition changes', () => {
  const session = setup()
  const first = selected(session)
  passed(session, first)
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Different request' }] }), { surfaceOp: 'append' })
  const before = verificationView(state(session), [check])
  expect(before.status).toBe('passed')
  expect(verificationView(state(Session.create(session.id, session.snapshotEvents())), [check])).toEqual(before)
  expect(verificationView(state(session), [{ ...check, description: 'More checks required' }])).toMatchObject({ status: 'unobserved', definitionCurrent: false, history: [{ current: false }] })
  selected(session, 'b'.repeat(40))
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'unobserved', history: [{ current: false, target: { commit } }] })
})

it('does not inherit parent successes or attribute results to a different request', () => {
  const session = setup()
  const first = selected(session)
  passed(session, first)
  expect(verificationView(state(session, SessionLogOffset(session.seq)), [check])).toMatchObject({ status: 'unobserved', target: null, requests: [], history: [] })
  const message = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Different request' }] }), { surfaceOp: 'append' })
  selected(session, commit, message.seq)
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'unobserved', history: [{ current: false }] })
})

it('withdraws currentness when the selected user message is replaced', () => {
  const session = setup()
  passed(session, selected(session))
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Different request' }] }),
    { surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) }, sourceEventSeqs: [SessionSeq(0)] })
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'unobserved', definitionCurrent: false, history: [{ current: false }] })
})

it('shows invalid stored records rather than silently certifying their asserted success', () => {
  const session = setup()
  const first = selected(session)
  passed(session, first)
  // @ts-expect-error -- restored records are untrusted JSON from an earlier plugin build.
  appendPluginRecord(session, 'plugin:mydot/verification-observation', { version: 90, outcome: 'passed' })
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'unavailable', invalidRecords: true })
  const other = setup()
  selected(other, commit, SessionSeq(99))
  expect(state(other)).toMatchObject({ targets: [], invalidRecords: true })
})

it('rejects stored observation times that cannot be displayed as a JavaScript Date', () => {
  const session = setup()
  appendPluginRecord(session, 'plugin:mydot/verification-observation', {
    version: 1, targetSeq: selected(session), observedAt: 8_640_000_000_000_001,
    outcome: 'unavailable', reason: 'provider-unavailable',
  })
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'unavailable', invalidRecords: true, history: [] })
})

it('keeps attachment-only input out of text selection and expires a request replaced by empty text', () => {
  const session = setup()
  passed(session, selected(session))
  const image = { type: 'image' as const,
    attachment: { attachmentId: AttachmentId('request-image'), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 } }
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [image] }), { surfaceOp: 'append' })
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'passed', requests: [{ seq: 0 }] })
  const another = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Another request' }] }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: ' ' }] }),
    { surfaceOp: { op: 'replace', startSeq: another.seq, endSeq: another.seq }, sourceEventSeqs: [another.seq] })
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'passed', requests: [{ seq: 0 }] })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this separate request' }] }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [] }),
    { surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) }, sourceEventSeqs: [SessionSeq(0)] })
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'unobserved', definitionCurrent: false,
    requests: [{ text: 'Keep this separate request' }], history: [{ current: false }] })
})

it('rejects malformed target payloads and request or condition substitutions from stored JSON', () => {
  for (const data of [null, [], { version: 9 }]) {
    const session = setup()
    stored(session, 'plugin:mydot/verification-target', data)
    stored(session, 'plugin:mydot/verification-observation', 'damaged')
    expect(verificationView(state(session), [check])).toMatchObject({ invalidRecords: true, status: 'unavailable', target: null })
  }
  for (const changed of [{ request: { seq: SessionSeq(0), text: 'A different requirement' } }, { checkRevision: '0'.repeat(64) }]) {
    const session = setup()
    stored(session, 'plugin:mydot/verification-target', { version: 1, request: { seq: SessionSeq(0), text: 'Fix the parser' },
      commit, check, checkRevision: verificationCheckRevision(check), ...changed })
    expect(verificationView(state(session), [check])).toMatchObject({ invalidRecords: true, status: 'unavailable', target: null })
  }
})

const invalidObservations: [string, (record: ReturnType<typeof observed>) => unknown][] = [
  ['unselected target', record => ({ ...record, targetSeq: 99 })],
  ['external run URL', record => ({ ...record, run: { ...record.run, url: 'https://example.test/untrusted' } })],
  ['external job URL', record => ({ ...record, job: { ...record.job, url: 'https://example.test/untrusted' } })],
  ['job without run', ({ run: _run, ...record }) => record],
  ['missing job', ({ job: _job, ...record }) => record],
  ['success without source', ({ run: _run, job: _job, ...record }) => record],
  ['mismatched commit', record => ({ ...record, run: { ...record.run, commit: 'b'.repeat(40) } })],
  ['mismatched condition', record => ({ ...record, job: { ...record.job, name: 'Another condition' } })],
  ['ambiguous PR checkout', record => ({ ...record, run: { ...record.run, event: 'pull_request' } })],
  ['uncertainty claiming success', record => ({ ...record, outcome: 'unavailable' })],
  ['uncertainty claiming failure', record => ({ ...record, outcome: 'unavailable', reason: 'condition-failed' })],
  ['success with failure reason', record => ({ ...record, reason: 'condition-failed' })],
  ['success from a skipped job', record => ({ ...record, job: { ...record.job, conclusion: 'skipped' } })],
  ['failure with success reason', record => ({ ...record, outcome: 'failed', job: { ...record.job, conclusion: 'failure' } })],
  ['failure from a cancelled job', record => ({ ...record, outcome: 'failed', reason: 'condition-failed', job: { ...record.job, conclusion: 'cancelled' } })],
]
it.each(invalidObservations)('rejects inconsistent stored observation fields: %s', (_name, change) => {
  const session = setup()
  stored(session, 'plugin:mydot/verification-observation', change(observed(selected(session))))
  expect(verificationView(state(session), [check])).toMatchObject({ status: 'unavailable', invalidRecords: true, history: [] })
})

it.each(['failure', 'timed_out'])('retains an exact failed merge-group job with %s conclusion after restoration', (conclusion) => {
  const session = setup()
  const record = observed(selected(session))
  appendPluginRecord(session, 'plugin:mydot/verification-observation', { ...record, outcome: 'failed', reason: 'condition-failed',
    run: { ...record.run, event: 'merge_group' }, job: { ...record.job, conclusion } })
  expect(verificationView(state(Session.create(session.id, session.snapshotEvents())), [check]))
    .toMatchObject({ status: 'failed', invalidRecords: false, history: [{ current: true, observation: { job: { conclusion } } }] })
})

it('does not promote orphaned or forward-referencing observations from an untrusted projection checkpoint', () => {
  const session = setup()
  const targetSeq = selected(session)
  passed(session, targetSeq)
  const valid = state(session)
  const orphaned = verificationProjection.stateSchema.parse({ ...valid, targets: [] })
  expect(verificationView(orphaned, [check])).toMatchObject({ status: 'unobserved', target: null, history: [] })
  const future = verificationProjection.stateSchema.parse({ ...valid,
    targets: [{ ...valid.targets[0], seq: 99 }], observations: [] })
  const observation = createPluginRecord('plugin:mydot/verification-observation', observed(SessionSeq(99)), SessionSeq(session.seq))
  expect(foldVerification(future, observation)).toMatchObject({ invalidRecords: true, observations: [] })
})

/** CI source attribution and non-success outcomes without starting a workflow. */
import { expect, it, vi } from 'vitest'
import { readGitHubVerification } from '../src/verification-github.ts'
import { check, commit, job, run, target } from './verification-fixture.ts'

const signal = (): AbortSignal => new AbortController().signal
function reader(overrides: {
  run?: Record<string, unknown>
  jobs?: Record<string, unknown>[]
  fileSha?: string
  latest?: Record<string, unknown>
} = {}) {
  let runs = 0
  return vi.fn(async (endpoint: string) => {
    if (endpoint.includes('/contents/')) return { type: 'file', sha: overrides.fileSha ?? check.workflowFileSha }
    if (endpoint.includes('/jobs?')) return { jobs: overrides.jobs ?? [job] }
    runs += 1
    return { ...run, ...(runs > 1 ? overrides.latest ?? overrides.run : overrides.run) }
  })
}

it.each(['push', 'merge_group'])('attributes an exact %s attempt and a successful named job', async (event) => {
  const read = reader({ run: { event } })
  const result = await readGitHubVerification(target, run.id, read, signal())
  expect(result).toEqual({ outcome: 'passed', reason: 'condition-passed',
    run: { id: 123, attempt: 2, url: 'https://github.com/owner/repo/actions/runs/123/attempts/2', commit, event },
    job: { id: 456, url: 'https://github.com/owner/repo/actions/runs/123/job/456', name: job.name, conclusion: 'success' } })
  expect(read.mock.calls.map(([path]) => path)).toEqual([
    'repos/owner/repo/actions/runs/123', `repos/owner/repo/contents/.github/workflows/ci.yml?ref=${commit}`,
    'repos/owner/repo/actions/runs/123/attempts/2/jobs?per_page=100&page=1', 'repos/owner/repo/actions/runs/123',
  ])
})

it.each([
  [{ head_sha: 'b'.repeat(40) }, 'run-mismatch'],
  [{ repository: { full_name: 'other/repo' } }, 'run-mismatch'],
  [{ id: 124 }, 'run-mismatch'],
  [{ path: '.github/workflows/other.yml' }, 'run-mismatch'],
  [{ event: 'pull_request' }, 'unsupported-event'],
  [{ event: 'workflow_dispatch' }, 'unsupported-event'],
])('does not borrow evidence from mismatched source %j', async (change, reason) => {
  const read = reader({ run: change })
  expect(await readGitHubVerification(target, run.id, read, signal())).toMatchObject({ outcome: 'unavailable', reason })
  expect(read).toHaveBeenCalledTimes(1)
})

it('refuses changed checkout semantics and moving attempts', async () => {
  expect(await readGitHubVerification(target, run.id, reader({ fileSha: 'd'.repeat(40) }), signal()))
    .toMatchObject({ outcome: 'unavailable', reason: 'workflow-changed' })
  expect(await readGitHubVerification(target, run.id, reader({ latest: { run_attempt: 3 } }), signal()))
    .toMatchObject({ outcome: 'unavailable', reason: 'attempt-changed' })
})

it.each([
  ['failure', 'failed', 'condition-failed'], ['timed_out', 'failed', 'condition-failed'],
  ['skipped', 'unavailable', 'job-not-passed'], ['neutral', 'unavailable', 'job-not-passed'],
  ['cancelled', 'unavailable', 'job-not-passed'], [null, 'unavailable', 'job-not-passed'],
])('preserves %s without converting workflow-level success into a job pass', async (conclusion, outcome, reason) => {
  expect(await readGitHubVerification(target, run.id, reader({ jobs: [{ ...job, conclusion }] }), signal()))
    .toMatchObject({ outcome, reason })
})

it('distinguishes unfinished, missing, ambiguous, and other-attempt jobs', async () => {
  for (const [jobs, reason] of [
    [[{ ...job, status: 'in_progress' }], 'job-not-completed'], [[], 'job-missing'],
    [[job, { ...job, id: 457 }], 'job-ambiguous'], [[{ ...job, head_sha: 'b'.repeat(40) }], 'run-mismatch'],
    [[{ ...job, run_attempt: 1 }], 'run-mismatch'], [[{ ...job, run_id: 124 }], 'run-mismatch'],
  ] as const) {
    expect(await readGitHubVerification(target, run.id, reader({ jobs: [...jobs] }), signal())).toMatchObject({ outcome: 'unavailable', reason })
  }
})

it('reads later pages and rejects malformed external responses', async () => {
  const read = reader()
  read.mockImplementationOnce(async () => run).mockImplementationOnce(async () => ({ type: 'file', sha: check.workflowFileSha }))
    .mockImplementationOnce(async () => ({ jobs: Array.from({ length: 100 }, (_, id) => ({ ...job, id: id + 1, name: 'Other' })) }))
    .mockImplementationOnce(async () => ({ jobs: [job] }))
  expect(await readGitHubVerification(target, run.id, read, signal())).toMatchObject({ outcome: 'passed' })
  expect(read.mock.calls[3]?.[0]).toContain('page=2')
  await expect(readGitHubVerification(target, run.id, async () => ({ conclusion: 'success' }), signal())).rejects.toThrow()
})

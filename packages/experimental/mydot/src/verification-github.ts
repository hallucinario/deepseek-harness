/** Read-only classification of existing GitHub Actions source-commit evidence. */
import { z } from 'zod'
import type { VerificationObservation, VerificationTarget } from './verification-types.ts'

/** Existing GitHub authentication and transport; callers cannot submit a verdict. */
export type GitHubEvidenceReader = (endpoint: string, signal: AbortSignal) => Promise<unknown>
/** Provider result before its Session envelope is appended. */
export type VerificationResult = Omit<VerificationObservation, 'seq' | 'targetSeq' | 'observedAt'>

const positiveId = z.number().int().positive()
const runSchema = z.object({
  id: positiveId, run_attempt: positiveId, event: z.string(), path: z.string(), head_sha: z.string(),
  repository: z.object({ full_name: z.string() }),
})
const jobsSchema = z.object({ jobs: z.array(z.object({
  id: positiveId, run_id: positiveId, run_attempt: positiveId, name: z.string(), head_sha: z.string(),
  status: z.string(), conclusion: z.string().nullable(),
})) })
const contentSchema = z.object({ type: z.literal('file'), sha: z.string() })

/** Fetch the selected existing attempt and its job without triggering or rerunning CI.
 * @param target - Immutable user selection and reviewed deployment condition.
 * @param runId - Existing GitHub Actions run identity.
 * @param read - Read-only GitHub API capability.
 * @param signal - One operation's cancellation and deadline.
 * @returns A scoped observation; absence, mismatches and incomplete attempts never pass.
 */
export async function readGitHubVerification(
  target: VerificationTarget, runId: number, read: GitHubEvidenceReader, signal: AbortSignal,
): Promise<VerificationResult> {
  const prefix = `repos/${target.check.repository}`
  const first = runSchema.parse(await read(`${prefix}/actions/runs/${runId}`, signal))
  const run = { id: first.id, attempt: first.run_attempt,
    url: `https://github.com/${target.check.repository}/actions/runs/${first.id}/attempts/${first.run_attempt}`, commit: first.head_sha, event: first.event }
  if (first.id !== runId || first.repository.full_name.toLowerCase() !== target.check.repository.toLowerCase()
    || first.head_sha !== target.commit || first.path !== target.check.workflowPath) {
    return { outcome: 'unavailable', reason: 'run-mismatch', run }
  }
  if (first.event !== 'push' && first.event !== 'merge_group') return { outcome: 'unavailable', reason: 'unsupported-event', run }
  const file = contentSchema.parse(await read(`${prefix}/contents/${target.check.workflowPath}?ref=${target.commit}`, signal))
  if (file.sha !== target.check.workflowFileSha) return { outcome: 'unavailable', reason: 'workflow-changed', run }
  const matches: z.infer<typeof jobsSchema>['jobs'] = []
  let page = 1
  for (;;) {
    signal.throwIfAborted()
    const result = jobsSchema.parse(await read(`${prefix}/actions/runs/${runId}/attempts/${first.run_attempt}/jobs?per_page=100&page=${page}`, signal))
    matches.push(...result.jobs.filter(job => job.name === target.check.jobName))
    if (result.jobs.length < 100) break
    page += 1
  }
  const current = runSchema.parse(await read(`${prefix}/actions/runs/${runId}`, signal))
  if (current.id !== first.id || current.head_sha !== first.head_sha || current.run_attempt !== first.run_attempt) {
    return { outcome: 'unavailable', reason: 'attempt-changed', run }
  }
  const selected = matches[0]
  if (selected === undefined) return { outcome: 'unavailable', reason: 'job-missing', run }
  if (matches.length !== 1) return { outcome: 'unavailable', reason: 'job-ambiguous', run }
  if (selected.run_id !== runId || selected.run_attempt !== first.run_attempt || selected.head_sha !== target.commit) {
    return { outcome: 'unavailable', reason: 'run-mismatch', run }
  }
  const job = { id: selected.id, name: selected.name, conclusion: selected.conclusion,
    url: `https://github.com/${target.check.repository}/actions/runs/${runId}/job/${selected.id}` }
  if (selected.status !== 'completed') return { outcome: 'unavailable', reason: 'job-not-completed', run, job }
  switch (selected.conclusion) {
    case 'success': return { outcome: 'passed', reason: 'condition-passed', run, job }
    case 'failure':
    case 'timed_out': return { outcome: 'failed', reason: 'condition-failed', run, job }
    default: return { outcome: 'unavailable', reason: 'job-not-passed', run, job }
  }
}

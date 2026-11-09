/** Shared exact request and reviewed workflow for keyless evidence scenarios. */
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { verificationCheckSchema, verificationCheckRevision } from '../src/verification-records.ts'
import type { VerificationTarget } from '../src/verification-types.ts'

export const check = verificationCheckSchema.parse({ id: 'repo-lint', repository: 'owner/repo',
  workflowPath: '.github/workflows/ci.yml', workflowFileSha: 'c'.repeat(40), jobName: 'Lint (Static)', description: 'Static checks pass' })
export const commit = 'a'.repeat(40)
export const target: VerificationTarget = { seq: SessionSeq(1), request: { seq: SessionSeq(0), text: 'Fix the parser' },
  commit, check, checkRevision: verificationCheckRevision(check) }
export const run = { id: 123, run_attempt: 2, event: 'push', path: check.workflowPath, head_sha: commit, repository: { full_name: check.repository } }
export const job = { id: 456, run_id: run.id, run_attempt: run.run_attempt, name: check.jobName, head_sha: commit, status: 'completed', conclusion: 'success' }

/** Fixed owner-private Unix-socket recorder status, independent of any model output. */
import { connect } from 'node:net'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { recorderStatusSchema } from './filing-state.ts'
import type { RecorderStatus } from './filing-types.ts'
/** Explicit deployment deadline and the existing bounded message allowance. */
export interface RecorderConnection { socketPath: string; timeoutMs: number; maxBytes: number }
const hex = z.string().regex(/^[a-f0-9]{64}$/)
const caseIdentity = z.string().regex(/^[a-f0-9]{32}$/)
const reference = z.string().regex(/^[a-f0-9]{32}\/[0-9]{8,}\.json$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hostStatus = z.object({
  version: z.literal('high-impact-recorder/v1'), caseId: caseIdentity, planDigest: hex,
  state: z.enum(['starting', 'recording', 'protected', 'failed', 'stopped']),
  evidence: z.enum(['complete', 'partial', 'unavailable']), readyForConfirmation: z.boolean(),
  sequence: time, observedAt: time, archiveRef: reference,
  segments: z.array(z.object({ ref: reference, start: z.number().nonnegative(), end: z.number().nonnegative(),
    round: z.number().int().positive(), startedAt: time, monotonicNs: z.string().regex(/^[0-9]+$/), sha256: hex }).strict()),
  protectedIntervals: z.array(z.object({ ref: caseIdentity, start: time, end: time.nullable() }).strict()),
  gaps: z.array(z.object({ start: time, reason: z.string().regex(/^[a-z_]+$/) }).strict()),
  deadline: z.iso.datetime({ offset: true }), receipt: z.object({ outcome: z.enum(['accepted', 'rejected', 'unknown', 'not_submitted']) }).strict(),
  queryRequired: z.boolean(), operationLogs: z.array(reference), operatorDigest: hex,
}).strict()
const responseSchema = z.object({ ok: z.literal(true), result: hostStatus }).strict()
/** Read one bounded JSON-line response from the configured recorder.
 * @param config - Trusted local configuration, never supplied by the model.
 * @param caseId - Exact case under owner review.
 * @param planDigest - Server-computed reviewed digest.
 * @returns Strictly decoded status; the workflow additionally verifies freshness and readiness.
 */
export async function readRecorderStatus(config: RecorderConnection, caseId: string, planDigest: string): Promise<RecorderStatus> {
  const parent = dirname(config.socketPath)
  if (!isAbsolute(config.socketPath) || await realpath(parent) !== parent) throw new Error('Recorder requires a canonical private socket directory')
  const [directory, target] = await Promise.all([lstat(parent), lstat(config.socketPath)])
  const uid = process.getuid?.()
  if (uid === undefined || directory.uid !== uid || (directory.mode & 0o077) !== 0 || !target.isSocket() || target.uid !== uid) {
    throw new Error('Recorder requires an owner-private directory and owner socket')
  }
  return new Promise((resolve, reject) => {
    const socket = connect(config.socketPath)
    const chunks: Buffer[] = []; let size = 0; let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true; clearTimeout(deadline); socket.destroy()
      if (error !== undefined) { reject(error); return }
      try {
        const status = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).result
        resolve(recorderStatusSchema.parse({
          version: status.version, caseId: status.caseId, planDigest: status.planDigest, state: status.state,
          evidence: status.evidence, readyForConfirmation: status.readyForConfirmation, sequence: status.sequence,
          observedAt: status.observedAt, archiveRef: status.archiveRef.replace('/', ':'),
          segments: status.segments.map(segment => segment.ref.replace('/', ':')),
          protectedIntervals: status.protectedIntervals.map(interval => interval.ref),
          gaps: status.gaps.map((gap, index) => `gap-${index}-${gap.start}-${gap.reason}`),
        }))
      }
      catch (_error: unknown) { reject(new Error('Recorder returned invalid status fields')) }
    }
    const deadline = setTimeout(() => { finish(new Error('Recorder status deadline exceeded')) }, config.timeoutMs)
    socket.once('error', () => { finish(new Error('Recorder socket unavailable')) })
    socket.once('connect', () => { socket.write(JSON.stringify({ command: 'status', caseId, planDigest }) + '\n') })
    socket.on('data', (data: Buffer) => {
      size += data.byteLength
      if (size > config.maxBytes) { finish(new Error('Recorder status exceeds configured byte allowance')); return }
      chunks.push(data)
      if (data.includes(10)) finish()
    })
    socket.once('end', () => { finish() })
  })
}

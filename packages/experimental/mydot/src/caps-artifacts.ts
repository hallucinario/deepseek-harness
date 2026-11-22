/** Verify every Caps document handoff against its bounded manifest and runtime receipt. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { capsDigest, type BundleInput, type CapsOutcome, type CapsScope } from './caps-mcp.ts'

/** Workspace-local prefix reserved for the trusted launcher. */
export const capsHandoffDirectory = '.dsh-caps'

const manifest = z.object({
  name: z.string(),
  documentCount: z.number().int(),
  documents: z.array(z.object({
    source: z.string(),
    file: z.string().regex(/^docs\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })),
})

async function readHandedOff(root: string, relativePath: string, digest: string, maxBytes: number, signal: AbortSignal) {
  const path = join(root, relativePath)
  if (await realpath(path) !== path) throw new Error('Caps handoff path is not canonical')
  await using file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const before = await file.stat()
  if (!before.isFile() || before.size > maxBytes) throw new Error('Caps handoff must be a bounded regular file')
  const buffer = Buffer.alloc(before.size + 1)
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
  const after = await file.stat()
  const current = await lstat(path)
  signal.throwIfAborted()
  const bytes = buffer.subarray(0, bytesRead)
  if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || current.dev !== after.dev || current.ino !== after.ino || await realpath(path) !== path || capsDigest(bytes) !== digest) throw new Error('Caps handoff changed or failed digest verification')
  return { path, bytes, digest }
}

/** Verify the complete manifest and document set before presenting any file.
 * @param scope - Exact DSH task and selected workspace.
 * @param input - Requested bundle identity and ordered document sources.
 * @param outcome - Validated Caps invocation projection and receipt.
 * @param maxBytes - Existing MyDot text reader limit per artifact.
 * @param signal - Tool lifetime.
 * @returns All validated file identities, or absence when no complete bundle was verified.
 */
export async function verifyCapsBundle(
  scope: CapsScope, input: BundleInput, outcome: CapsOutcome, maxBytes: number, signal: AbortSignal,
): Promise<{ path: string; digest: string }[] | undefined> {
  const { receipt, invocationId, bundle } = outcome
  if (outcome.status !== 'succeeded' || bundle?.bundle !== input.name || bundle.documentCount !== input.documents.length
    || invocationId === undefined || receipt?.outputValidation !== 'passed') return undefined
  if (receipt.artifactObservations.length !== bundle.documentCount + 1) return undefined
  const root = join(scope.workspace, capsHandoffDirectory, scope.requestId)
  const read = async (relativePath: string) => {
    const reference = capsDigest(JSON.stringify([scope.requestId, invocationId, relativePath]))
    const item = receipt.artifactObservations.find(entry => entry.reference === reference && entry.status === 'observed')
    if (item?.observedDigest == null) throw new Error('Caps receipt has no matching artifact')
    return readHandedOff(root, relativePath, item.observedDigest, maxBytes, signal)
  }
  try {
    const checkedManifest = await read('bundle/manifest.json')
    const parsed = manifest.parse(JSON.parse(checkedManifest.bytes.toString('utf8')))
    if (parsed.name !== input.name || parsed.documentCount !== bundle.documentCount
      || parsed.documents.length !== bundle.documentCount
      || new Set(parsed.documents.map(document => document.file)).size !== parsed.documents.length) return undefined
    const files = [{ path: checkedManifest.path, digest: checkedManifest.digest }]
    for (const [index, document] of parsed.documents.entries()) {
      if (document.source !== input.documents[index]?.source) return undefined
      const file = await read('bundle/' + document.file)
      if (document.bytes !== file.bytes.length || 'sha256:' + document.sha256 !== file.digest) return undefined
      files.push({ path: file.path, digest: file.digest })
    }
    return files
  } catch {
    return undefined
  }
}

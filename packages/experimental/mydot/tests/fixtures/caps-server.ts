/** Fixed synthetic document capability for keyless MyDot stdio tests. */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const args = process.argv.slice(2)
const checkedArgs = z.tuple([
  z.literal('--dsh-version'), z.string().min(1), z.literal('--workspace'), z.string().min(1),
  z.literal('--space-id'), z.string().min(1), z.literal('--session-ref'), z.string().min(1),
  z.literal('--task-ref'), z.string().min(1), z.literal('--execution-ref'), z.string().min(1), z.literal('--request-id'), z.string().min(1),
]).parse(args)
const [, version, , workspace, , spaceId, , sessionRef, , taskRef, , executionRef, , requestId] = checkedArgs
const invocationId = 'inv-stdio-fixture'
const sha = (value: string | Uint8Array) => 'sha256:' + createHash('sha256').update(value).digest('hex')
const fingerprint = sha('fixture-fingerprint')
const authority = { taskRef, sessionRef, executionRef, authorityDigest: sha(taskRef) }
const binding = { apiVersion: 'output.hcap.hallucinar.io/v1', capabilityId: 'docs.bundle.compile', interfaceId: 'cli' }
const observation = { 'hcap.hallucinar.io/observation': { status: 'ok', eventId: '00000000-0000-4000-8000-000000000000' } }
const inputSchema = z.object({ capabilityId: z.literal(binding.capabilityId), interfaceId: z.literal(binding.interfaceId),
  input: z.object({ name: z.string(), documents: z.array(z.object({ source: z.string() })) }) })
const handle = (structuredContent: Record<string, unknown>, isError = false) => ({
  // The consumer must use structured fields and ignore untrusted raw text.
  content: [{ type: 'text' as const, text: 'synthetic Caps data' }], structuredContent, isError, _meta: observation,
})

serveStdio(() => {
  const server = new McpServer({ name: 'hcap', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('check', { inputSchema }, async ({ input }) => {
    await appendFile(join(workspace, 'calls.jsonl'), JSON.stringify({ phase: 'check', requestId, sessionRef, taskRef, executionRef, version, spaceId }) + '\n')
    if (input.name === 'check-lost') process.exit(18)
    if (input.name === 'bad-check') return handle({ unsupported: true })
    const status = input.name === 'approval' ? 'needs_approval' : 'ready'
    const bindingAuthority = input.name === 'other-task' ? { ...authority, taskRef: 'foreign-task' } : authority
    return handle({ ...binding, kind: 'CapabilityCheckResult', status, authority: bindingAuthority,
      executionFingerprint: fingerprint, installedVersion: '0.4.1' })
  })
  server.registerTool('invoke', { inputSchema: inputSchema.extend({ expectedFingerprint: z.literal(fingerprint), requestId: z.literal(requestId) }) }, async ({ input }) => {
    await appendFile(join(workspace, 'calls.jsonl'), JSON.stringify({ phase: 'invoke', requestId }) + '\n')
    if (input.name === 'abort-invoke') {
      await writeFile(join(workspace, 'invoke-ready'), '')
      return new Promise<never>(() => { /* Hold the reply until the caller aborts the real transport. */ })
    }
    if (input.name === 'lost') process.exit(19)
    if (input.name === 'bad-wire') return handle({ unsupported: true })
    if (input.name === 'denied') return handle({ error: { code: 'HCAP_POLICY_DENIED' } }, true)
    const path = join(workspace, '.dsh-caps', requestId)
    const content = Buffer.concat(await Promise.all(input.documents.map(doc => readFile(join(workspace, doc.source)))))
    if (input.name === 'inflight' || input.name === 'bad-null') {
      return { ...handle({ ...binding, kind: 'CapabilityInvocationResult', requestId, status: 'unknown',
        invocationId: null, executionFingerprint: fingerprint, resultDigest: null, result: null,
        duplicate: input.name === 'inflight', componentExitCode: null, recordingStatus: 'ok' }, true), _meta: undefined }
    }
    const file = posix.join('docs', 'guide.md')
    const docs = input.documents.map(doc => ({ source: doc.source, title: 'Public guide',
      file, bytes: content.length, sha256: sha(content).slice(7) }))
    if (input.name === 'foreign-source') docs[0]!.source = 'foreign.md'
    if (input.name === 'wrong-bytes') docs[0]!.bytes += 1
    if (input.name === 'bad-path') docs[0]!.file = ['docs', '..', 'outside.md'].join('/')
    const documentCount = docs.length
    const manifest = JSON.stringify({ name: input.name === 'wrong-manifest' ? 'other' : input.name, documentCount, documents: docs })
    if (input.name !== 'cancelled') {
      await mkdir(join(path, 'bundle', 'docs'), { recursive: true })
      await writeFile(join(path, 'bundle', 'manifest.json'), manifest)
      const target = join(path, 'bundle', file)
      if (input.name === 'linked') await symlink(join(workspace, 'guide.md'), target)
      else if (input.name === 'directory') await mkdir(target)
      else if (input.name !== 'missing-file') await writeFile(target, input.name === 'changed' ? Buffer.from('changed bytes') : content)
    }
    const result = { bundle: input.name === 'wrong-name' ? 'other' : input.name, documentCount, output: 'bundle', warnings: [] }
    const status = input.name === 'cancelled' ? 'cancelled' : 'succeeded'
    const resultDigest = status === 'succeeded' ? sha(input.name === 'wrong-digest' ? 'other-result' : JSON.stringify(result)) : null
    const receipt = {
      version: 'receipt/2', requestRef: sha(requestId), invocationRef: sha(invocationId),
      executionFingerprint: fingerprint, resultDigest, authority: input.name === 'other-receipt' ? { ...authority, sessionRef: 'other-session' } : authority,
      outputValidation: status === 'succeeded' ? 'passed' : 'not_run',
      verification: { status: status === 'succeeded' ? 'not_verified' : 'unknown' },
      artifactObservations: status === 'succeeded' ? [
        { reference: sha(JSON.stringify([requestId, invocationId, 'bundle/manifest.json'])), observedDigest: sha(manifest), status: 'observed' },
        ...input.name === 'partial-receipt' ? [] : [{
          reference: sha(JSON.stringify([requestId, invocationId, input.name === 'missing-reference' ? 'bundle/other.md' : 'bundle/' + file])),
          observedDigest: sha(content), status: 'observed',
        }],
      ] : [],
    }
    return handle({ ...binding, kind: 'CapabilityInvocationResult', status, requestId: input.name === 'wrong-request' ? 'other-request' : requestId, invocationId,
      executionFingerprint: fingerprint, resultDigest, result: status === 'succeeded' ? result : null, receipt, duplicate: false,
      componentExitCode: status === 'succeeded' ? 0 : null, recordingStatus: 'ok' }, status !== 'succeeded')
  })
  return server
})

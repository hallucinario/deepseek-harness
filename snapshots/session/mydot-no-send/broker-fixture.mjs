/** Deterministic external broker around the real MyDot tools and shipped dsh profile. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'mydot-broker-fixture'
export const inject = ['tools', 'systemPrompt']

export async function apply(ctx) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mydot-snapshot-'))
  ctx.effect(() => () => rm(root, { recursive: true, force: true }), 'mydot snapshot: private credential directory')
  const executorTokenFile = join(root, 'executor.token')
  const token = 'mydot-snapshot-executor-fixture-token-000000000000'
  await writeFile(executorTokenFile, token, { mode: 0o600 })
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const request = JSON.parse(body)
      if (req.url !== '/v1/execute' || req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}` || typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
        res.writeHead(400)
        res.end('invalid authenticated broker request')
        return
      }
      requests.push(request)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (request.operation === 'connections.list') {
        res.end(JSON.stringify({ version: 1, ok: true, operation: 'connections.list', data: { connections: [
          { connectionId: 'work-account', provider: 'microsoft', label: 'Work Outlook', resources: [{ id: 'mailbox', label: 'Work mailbox', capabilities: ['mail.read'] }] },
        ] }, warnings: [] }))
        return
      }
      res.end(JSON.stringify({ version: 1, ok: false, error: { code: 'permission_denied', message: 'This Session has mail.read only. A human must grant mail.draft in the separate broker console.', outcome: 'not_started', retryable: false } }))
    })
  })
  ctx.effect(() => () => new Promise((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
    server.closeAllConnections()
  }), 'mydot snapshot: external broker')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Broker fixture has no TCP address')
  const entry = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
  const plugin = await import(new URL(`../../../packages/experimental/mydot-integrations/${entry}`, import.meta.url).href)
  await ctx.plugin(plugin, { brokerUrl: `http://127.0.0.1:${address.port}`, executorTokenFile })
  ctx.effect(() => () => {
    if (requests.length !== 2 || requests[0].operation !== 'connections.list' || requests[1].operation !== 'mail.createDraft'
      || requests[0].sessionId !== requests[1].sessionId || requests[1].connectionId !== 'work-account') {
      throw new Error('MyDot snapshot must dispatch only the account lookup and denied draft for the exact same Session')
    }
  }, 'mydot snapshot: observed request assertions')
}

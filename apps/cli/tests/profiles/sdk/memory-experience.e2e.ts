/** Durable capture, cross-session recall and human retirement through the built SDK profile. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { episodeSchema } from '../../../../../packages/experimental/memory-experience/src/domain.ts'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const release = process.env.DSH_MEMORY_SMOKE_RELEASE ?? root
const binary = join(release, 'apps/cli/lib/bin.js')
const service = join(release, 'packages/experimental/memory-experience/lib/index.js')
const fixture = fileURLToPath(new URL('./fixtures/memory-experience.ts', import.meta.url))
const proof = 'memory-proof-7391'
const request = `Create ${proof}.txt with the text ${proof} and verify its bytes with bash.`

describe('SDK execution experience memory', () => {
  it('persists original evidence, recalls it in another session, and retires it through human commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-memory-experience-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success', 'success', 'success', 'success'],
      toolName: 'bash',
      toolArguments: JSON.stringify({ command: `printf '${proof}' > '${proof}.txt'; cat '${proof}.txt'`, description: 'Write and verify the acceptance proof' }),
      successText: 'EXPERIENCE_OK',
    })
    onTestFinished(() => server.close())
    const home = join(directory, '.dsh')
    const patch = join(directory, 'memory.patch.yml')
    const reportPath = join(directory, 'commands.json')
    const createHarness = () => new DeepSeekHarness({
      dshBin: binary, profile: 'sdk', patches: [patch], dshHome: home,
      cwd: directory, processCwd: directory, provider: 'deepseek-official', model: 'memory-smoke',
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-memory-acceptance', DEEPSEEK_BASE_URL: server.baseURL, DSH_PERMISSION_MODE: 'danger-full-access' },
      requestTimeoutMs: 60_000,
    })
    let harness = createHarness()
    try {
      await writeFile(patch, JSON.stringify([
        { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', models: [{ id: 'memory-smoke' }], retryPolicy: { mode: 'normal', maxRetries: 0 } } },
        { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
        { id: 'session-title-llm', disabled: true },
        { id: 'session-log-deepseek', disabled: true },
        { id: 'plugin-package-inventory-deepseek', disabled: true },
        { id: 'skill-filesystem', config: { includeDefaultRoots: false } },
        { insert: [
          { id: 'memory-experience', name: service, config: { mode: 'retrieval', maxTokens: 3000, maxEpisodes: 2 } },
          { id: 'memory-experience-acceptance', name: fixture, config: { reportPath } },
        ] },
      ]))
      const first = await harness.session('memory-source').run(request)
      expect(first.finalResponse).toBe('EXPERIENCE_OK')
      expect(await readFile(join(directory, `${proof}.txt`), 'utf8')).toBe(proof)
      const second = await harness.session('memory-recall').run(`Continue work on ${proof}.txt; check the earlier bash verification.`)
      expect(second.finalResponse).toBe('EXPERIENCE_OK')
      const third = await harness.session('memory-retire').run(`Continue work on ${proof}.txt after retiring the old record.`)
      expect(third.finalResponse).toBe('EXPERIENCE_OK')
      await harness.close()
      harness = createHarness()
      const restarted = await harness.session('memory-after-restart').run(`Continue work on ${proof}.txt after restarting the Host.`)
      expect(restarted.finalResponse).toBe('EXPERIENCE_OK')
      await harness.close()

      const stored = z.object({ tables: z.object({ episodes: z.record(z.string(), episodeSchema) }) })
        .parse(JSON.parse(await readFile(join(home, 'storages/memory_experience.json'), 'utf8')))
      const episode = Object.values(stored.tables.episodes).find(value => value.sessionId === 'memory-source')
      expect(episode).toBeDefined()
      if (episode === undefined) throw new Error('the source episode was not durably stored')
      expect(episode?.state).toBe('retired')
      expect(episode?.outcome).toBe('unknown')
      expect(JSON.stringify(episode?.observations)).toContain(proof)
      const recall = second.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'runtime-context').map(event => JSON.stringify(event.data)).join('\n')
      expect(recall).toContain(proof)
      expect(recall).toContain('memory-source')
      expect(recall).toContain('"retention":"current"')
      const final = third.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'runtime-context').map(event => JSON.stringify(event.data)).join('\n')
      expect(final).not.toContain('memory-source')
      const commandReport = z.object({ id: z.string(), commands: z.array(z.object({ input: z.string(), result: z.object({ kind: z.literal('success') }) })) })
        .parse(JSON.parse(await readFile(reportPath, 'utf8')))
      expect(commandReport.commands).toHaveLength(4)

      const paths = await readdir(join(home, 'sessions'), { recursive: true })
      const logs = await Promise.all(paths.filter(path => /session\.v\d+\.jsonl$/u.test(path))
        .map(path => readFile(join(home, 'sessions', path), 'utf8')))
      const source = logs.find(log => log.includes('"id":"memory-source"'))
      if (source === undefined) throw new Error('the source Session was not durably stored')
      const sourceEvents = parseSessionLog(source)
      expect(sourceEvents[episode.request.eventSeq]).toMatchObject({ type: 'user/message' })
      expect(sourceEvents[episode.endSeq]).toMatchObject({ type: 'turn/end', data: { turn: episode.turn } })
      for (const observation of episode.observations) {
        expect(sourceEvents[observation.eventSeq]?.type).toBe(observation.kind === 'operation' ? 'tool/call' : 'tool/result')
      }
      expect(sourceEvents[episode.startSeq]).toMatchObject({ type: 'turn/start', data: { turn: episode.turn } })
      expect(sourceEvents.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes(proof))).toBe(true)
      expect(server.requests).toHaveLength(5)
      const wireRecall = JSON.stringify(server.requests[2]?.body)
      expect(wireRecall).toContain('memory-source')
      expect(JSON.stringify(server.requests[3]?.body)).not.toContain('memory-source')
      expect(JSON.stringify(server.requests[4]?.body)).not.toContain('memory-source')
      expect(Object.values(stored.tables.episodes).filter(value => value.sessionId === 'memory-source')).toHaveLength(1)
    } finally {
      await harness.close()
    }
  })
})

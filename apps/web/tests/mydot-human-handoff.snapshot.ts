/** Recorded preparation replays through the shipped Web profile without model charges. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-experimental-mydot'
import { assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, webSnapshotMode } from './scaffold.ts'

const directory = fileURLToPath(new URL('../../../snapshots/web/mydot-human-handoff', import.meta.url))
const fixture = join(directory, 'session.v4.jsonl')

it.skipIf(webSnapshotMode() === 'record')('replays a durable human request through the shipped Web profile', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: fixture, compareReplaySession: true,
    extraOverlayPath: join(directory, 'cordis.patch.yml'), toolsMode: 'native',
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/experimental/mydot/package.json', import.meta.url))],
    replayProviders: [{ id: 'human-handoff-fixture', name: 'Public fixture', models: [{ id: 'fixture' }] }] })
  try {
    const prompts = fixtureUserPrompts(await readFile(fixture, 'utf8'))
    expect(prompts).toHaveLength(1)
    const created = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    await scaffold.ctx.sessionController.prompt({ sessionId: created.sessionId, requestId: 'public-human-handoff-bootstrap' as SessionRequestId,
      mode: 'queue', content: [{ type: 'text', text: prompts[0]! }] }, new AbortController().signal)
    const agent = scaffold.ctx.agents.get(created.sessionId)!
    await agent.whenIdle()
    const requests = await scaffold.ctx.mydotHandoff.snapshot()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ phase: 'pending', request: { requestId: 'public-review', sessionId: created.sessionId,
      role: 'owner', reason: 'A separate human observation is needed before the saved result can be used', target: null } })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'mydot/human-handoff')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(1)
  } finally { await scaffold.close() }
  await assertFixtureInventory(directory, ['cordis.patch.yml', 'session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json'])
})

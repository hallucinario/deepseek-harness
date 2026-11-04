import { describe, expect, it } from 'vitest'
import { episodeSchema } from '../src/domain.ts'
import { resolveScope } from '../src/capture.ts'
import { selectExperiences, renderExperiences } from '../src/retrieval.ts'

function episode(id: string, groupId = id, text = 'build failure with dependency cache') {
  return episodeSchema.parse({
    id, groupId, scope: resolveScope(process.cwd(), process.cwd()), sessionId: 'past', turn: 1,
    startSeq: 0, endSeq: 4, capturedAt: 1,
    request: { eventSeq: 1, text }, observations: [{ kind: 'result', eventSeq: 3, tool: 'bash', text: 'concrete build output' }],
    outcome: 'unknown', state: 'active', truncated: false,
  })
}

describe('experience retrieval', () => {
  it('excludes the current work and retired records and contributes at most one episode per group', () => {
    const records = [episode('one', 'past-group'), episode('two', 'past-group'), episode('current', 'current-group'), { ...episode('retired'), state: 'retired' as const }]
    const selected = selectExperiences(records, 'build failure', 'current-group', 2)
    expect(selected.map(value => value.id)).toEqual(['one'])
    expect(selectExperiences(records, 'unmatched mineralogy', 'current-group', 2)).toEqual([])
  })

  it('uses the complete emitted text and retains source references at tiny and exact Unicode limits', () => {
    const value = episode('界', 'past', '日本語のビルド失敗'.repeat(400))
    const meter = (text: string) => Array.from(text).length
    const all = renderExperiences([value], 100000, meter).text
    expect(all).toContain('Observed at:')
    expect(all).toContain(`Project: ${process.cwd()}`)
    expect(all).toContain(`Working directory: ${process.cwd()}`)
    expect(renderExperiences([value], 0, meter).text).toBe('')
    expect(renderExperiences([value], 1, meter).text).toBe('')
    expect(renderExperiences([value], meter(all), meter).text).toBe(all)
    const bounded = renderExperiences([value], 500, meter).text
    expect(meter(bounded)).toBeLessThanOrEqual(500)
    expect(bounded).toContain('past#3')
    expect(bounded).toContain('Outcome: unknown')
    expect(bounded).not.toContain('\ufffd')
  })

  it('ranks more relevant and newer work before resolving stable lexical ties', () => {
    const older = { ...episode('z'), capturedAt: 1 }
    const newer = { ...episode('b'), capturedAt: 2 }
    const equallyNew = { ...episode('a'), capturedAt: 2, observedRevision: 'abcdef1234567' }
    expect(selectExperiences([older, newer, equallyNew], 'build failure', 'current', 2).map(value => value.id)).toEqual(['a', 'b'])
    expect(selectExperiences([older], 'build', 'current', 0)).toEqual([])
    expect(renderExperiences([equallyNew], 100000, text => text.length).text).toContain('Revision: abcdef1234567')
  })
})

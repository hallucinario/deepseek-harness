/** Pause is durable future-delivery admission, independent of past inbox receipts. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScheduleId, createDailyScheduleRecord } from '../src/domain.ts'
import { scheduleDomain } from '../src/storage.ts'
import { harness } from './harness.ts'

const contexts: Context[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T00:00:00Z')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

it('pauses and resumes the same Tokyo daily reminder across restart without losing history', async () => {
  const id = ScheduleId('tokyo-daily')
  const sessionId = SessionId('original')
  const record = createDailyScheduleRecord(id, 'review files', { time: '09:00:00', time_zone: 'Asia/Tokyo' }, Date.now(), 'Review')
  const receipt = { scheduledAt: '2026-11-06T00:00:00.000Z', deliveredAt: '2026-11-06T00:00:01.000Z', messageId: MessageId('delivered') }
  const first = await harness({ onContext: ctx => contexts.push(ctx), beforeService: async (_ctx, facility) => {
    const domain = await facility.open(scheduleDomain)
    await domain.table('tasks').put(id, { sessionId, record, status: 'active', lastDelivery: receipt })
    await domain.close()
  } })
  expect(await first.service.setPaused({ id, sessionId, paused: true })).toEqual({ id, status: 'paused' })
  expect(await first.service.list({ sessionId })).toEqual([])
  await vi.advanceTimersByTimeAsync(2 * 86400_000)
  expect(first.resolve).not.toHaveBeenCalled()
  await first.ctx.fiber.dispose()
  const second = await harness({ pool: first.pool, onContext: ctx => contexts.push(ctx) })
  expect(await second.service.catalog()).toEqual([{ ...record, sessionId, status: 'paused', lastDelivery: receipt }])
  expect(await second.service.setPaused({ id, sessionId: SessionId('wrong'), paused: false })).toEqual({ id, code: 'schedule_not_found' })
  expect(await second.service.setPaused({ id, sessionId, paused: false })).toEqual({ id, status: 'active' })
  const resumed = (await second.service.catalog())[0]!
  expect(resumed.id).toBe(id)
  expect(resumed.kind).toBe('daily')
  expect(resumed.scheduledAt).toBe('2026-11-10T00:00:00.000Z')
  expect(resumed.lastDelivery).toEqual(receipt)
  expect(second.resolve).not.toHaveBeenCalled()
})

it('does not resurrect a completed one-shot task', async () => {
  const id = ScheduleId('ended')
  const sessionId = SessionId('original')
  const test = await harness({ onContext: ctx => contexts.push(ctx), beforeService: async (_ctx, facility) => {
    const domain = await facility.open(scheduleDomain)
    await domain.table('tasks').put(id, { sessionId, status: 'inactive', record: {
      id, kind: 'at', title: 'Done', prompt: 'done', scheduledAt: '2026-11-06T00:00:00.000Z',
    } })
    await domain.close()
  } })
  expect(await test.service.setPaused({ id, sessionId, paused: false })).toEqual({ id, code: 'schedule_ended' })
})

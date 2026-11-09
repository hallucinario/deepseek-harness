/** Complete typed command fixtures fail if a scenario invokes an unconfigured action. */
import { vi } from 'vitest'
import type { Commands } from '../src/client/props.ts'

export function clientCommands() {
  const unexpected = () => { throw new Error('Unconfigured MyDot command') }
  return {
    retry: vi.fn(unexpected), newRequestId: vi.fn(unexpected),
    presentResults: vi.fn(async () => unexpected()), releaseDesktop: vi.fn(async () => unexpected()),
    saveSpace: vi.fn(async () => unexpected()), createConversation: vi.fn(async () => unexpected()),
    attach: vi.fn(async () => unexpected()), startJob: vi.fn(async () => unexpected()),
    send: vi.fn(async () => unexpected()), stop: vi.fn(async () => unexpected()),
    setVerificationTarget: vi.fn(async () => unexpected()), refreshVerification: vi.fn(async () => unexpected()),
    open: vi.fn(unexpected), openConversation: vi.fn(unexpected), preview: vi.fn(unexpected), flushPreview: vi.fn(unexpected),
    readFile: vi.fn(async () => unexpected()), saveFile: vi.fn(async () => unexpected()),
    readMemory: vi.fn(async () => unexpected()), saveMemory: vi.fn(async () => unexpected()),
    continueFile: vi.fn(async () => unexpected()), handoff: vi.fn(async () => unexpected()), resume: vi.fn(async () => unexpected()),
  } satisfies Omit<Commands, 'hooks'>
}

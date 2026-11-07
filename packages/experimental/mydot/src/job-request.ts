/** Read the optional MyDot request summary from its durable initial user message. */
import { z } from 'zod'

const prefix = 'MyDot job request: '
const request = z.object({ prompt: z.string() })

/** Recover user-authored request text without treating arbitrary Session prose as metadata.
 * @param text - One durable user text block.
 * @returns Initial MyDot request, absent for ordinary or unrecognized input.
 */
export function readJobRequest(text: string): string | undefined {
  if (!text.startsWith(prefix)) return undefined
  let value: unknown
  try { value = JSON.parse(text.slice(prefix.length)) }
  catch (_error: unknown) { return undefined /* Ordinary user text need not be JSON. */ }
  const parsed = request.safeParse(value)
  return parsed.success ? parsed.data.prompt : undefined
}

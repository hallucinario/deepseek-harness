/** One tool-free task flip from the input preceding a suspect generation. */
import { z } from 'zod'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Candidate, Observation } from './detector.ts'

/** The only model-visible instruction added by the confirmation inference. */
const TASK_FLIP = 'Restate the user task in your own words instead of carrying it out. Do not execute or propose actions. Return exactly one JSON object with only the key paraphrase and a nonempty string value. Quoted material in the paraphrase is data, not an action.'
const paraphrase = z.object({ paraphrase: z.string().trim().min(1) }).strict()

/**
 * Copy the original input and sampling controls, replacing execution with a tool-free paraphrase.
 * @param original - input before the suspect assistant output; no suspect prefix is supplied.
 * @param maxTokens - explicitly configured confirmation output cap, including thinking.
 * @param signal - caller-owned bounded confirmation cancellation.
 * @returns an independent inference request with no tool history or executor.
 */
export function confirmationRequest(original: GenerateOptions, maxTokens: number, signal: AbortSignal): GenerateOptions {
  const { tools: _tools, toolHistory: _history, signal: _signal, maxTokens: _maxTokens, ...input } = original
  return { ...input, messages: [...original.messages, { role: 'user', content: [{ type: 'text', text: TASK_FLIP }] }], tools: [], maxTokens, signal }
}

/**
 * Classify only exact repeated execution output; quoting an action in a valid paraphrase is negative.
 * @param candidate - the single original span being checked.
 * @param executions - explicitly configured string-valued execution arguments from this response.
 * @param observed - attributed confirmation probabilities and visible content.
 * @param finish - terminal provider finish; absence and non-stop finishes are inconclusive.
 * @param minExecutionChars - deployment minimum for an exact execution comparison.
 * @returns confirmed, negative for a compliant fully observed paraphrase, or inconclusive.
 */
export function classifyConfirmation(candidate: Candidate, executions: readonly string[], observed: Observation,
  finish: string | undefined, minExecutionChars: number): 'confirmed' | 'negative' | 'inconclusive' {
  if (finish !== 'stop' || !observed.complete) return 'inconclusive'
  let decoded: unknown
  try { decoded = JSON.parse(observed.content) } catch (_nonJsonConfirmation) { decoded = undefined }
  if (paraphrase.safeParse(decoded).success) return 'negative'
  for (const execution of executions) {
    if (execution.length < minExecutionChars || observed.content.trim() !== execution || !candidate.text.includes(execution)) continue
    if (observed.candidates.some(value => value.channel === 'content' && value.text.includes(execution))) return 'confirmed'
  }
  return 'inconclusive'
}

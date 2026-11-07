/** Host-only transport configuration. Provider and administrative credentials never enter this package. */

import { isAbsolute } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/** Settings resolved once per plugin generation. */
export interface Config {
  /** Broker origin; HTTPS, or loopback HTTP on 127.0.0.1. */
  brokerUrl: string
  /** Private regular file containing only the Host executor credential. */
  executorTokenFile: string
  /** Protected Unix executor socket; when present, HTTP execution is never attempted. */
  executorSocketPath?: string
  /** Entire request deadline in milliseconds; defaults to 30000. */
  requestTimeoutMs?: number
  /** Complete model-visible UTF-8 result budget; defaults to 65536 bytes. */
  maxResultBytes?: number
}

/** Profile schema; the token's contents are never accepted as configuration. */
export const Config: Schema<Config> = Schema.object({
  brokerUrl: Schema.string().required().description('HTTPS broker origin, or HTTP on 127.0.0.1.'),
  executorTokenFile: Schema.string().role('secret').required().description('Absolute path to a private executor-token file; never the human administrator token.'),
  executorSocketPath: Schema.string().description('Absolute path to the protected broker executor socket; required by the restricted local profile.'),
  requestTimeoutMs: Schema.number().step(1).min(1).max(120_000).default(30_000),
  maxResultBytes: Schema.number().step(1).min(512).max(1_048_576).default(65_536),
})

/** Validated immutable transport limits. */
export interface ResolvedConfig {
  readonly brokerUrl: string
  readonly executorTokenFile: string
  readonly executorSocketPath?: string
  readonly requestTimeoutMs: number
  readonly maxResultBytes: number
}

/**
 * Validate a profile before registering any tools.
 * @param input - Loader-validated or programmatically supplied configuration.
 * @returns The canonical origin and complete limits.
 */
export function resolveConfig(input: Config): ResolvedConfig {
  const config = Config(input)
  const url = new URL(config.brokerUrl)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    throw new TypeError('MyDot brokerUrl must be an HTTPS origin, or HTTP on 127.0.0.1, without credentials, a path, query or fragment.')
  }
  if (!isAbsolute(config.executorTokenFile)) throw new TypeError('MyDot executorTokenFile must be an absolute private file path.')
  if (config.executorSocketPath !== undefined && !isAbsolute(config.executorSocketPath)) {
    throw new TypeError('MyDot executorSocketPath must be an absolute protected socket path.')
  }
  return Object.freeze({
    brokerUrl: url.origin,
    executorTokenFile: config.executorTokenFile,
    ...config.executorSocketPath === undefined ? {} : { executorSocketPath: config.executorSocketPath },
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
    maxResultBytes: config.maxResultBytes ?? 65_536,
  })
}

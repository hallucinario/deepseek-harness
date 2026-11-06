/** Isolated Google Calendar and Microsoft Outlook broker, loaded only through a dedicated dsh profile. */

import { isAbsolute } from 'node:path'
import { hkdfSync } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrokerOAuth } from './oauth.ts'
import { IntegrationBroker, type RuntimeOptions } from './runtime.ts'
import { BrokerServer, type ServerOptions } from './server.ts'
import { BrokerStore, readSecret } from './store.ts'

/** Cordis function-plugin identity. */
export const name = 'mydot-integration-broker'
/** The isolated profile requires no agent, shell, browser or credential services. */
export const inject: string[] = []

/** Required protected deployment paths and explicit service bounds. */
export interface Config extends RuntimeOptions, ServerOptions {
  /** Private, broker-user-owned directory containing encrypted SQLite records. */
  stateDirectory: string
  /** Protected file containing a 64-character hexadecimal AES-256 key. */
  encryptionKeyFile: string
  /** Protected execution credential shared only with the trusted Harness Host. */
  executorTokenFile: string
  /** Independent human administrator credential, unavailable to the agent process. */
  adminTokenFile: string
  /** Protected JSON configuration containing dedicated Google and/or Microsoft OAuth clients. */
  oauthConfigFile: string
}

/** Validated deployment configuration; the no-send policy has no override switch. */
export const Config: z<Config> = z.object({
  host: z.const('127.0.0.1').required(),
  port: z.number().step(1).min(0).max(65535).required(),
  publicOrigin: z.string().required(),
  executorSocketPath: z.string(),
  adminSocketPath: z.string(),
  stateDirectory: z.string().required(), encryptionKeyFile: z.string().required(),
  executorTokenFile: z.string().required(), adminTokenFile: z.string().required(), oauthConfigFile: z.string().required(),
  requestTimeoutMs: z.number().step(1).min(1000).max(120_000).required(),
  maxBodyBytes: z.number().step(1).min(1024).max(1_000_000).required(),
  maxResponseBytes: z.number().step(1).min(4096).max(4_000_000).required(),
  maxQueuedRequests: z.number().step(1).min(1).max(100).required(),
  maxGrantLifetimeMs: z.number().step(1).min(60_000).max(86_400_000).required(),
  microsoftConditionalWritesVerified: z.boolean().default(false),
})

/**
 * Open the encrypted store and effect-owned listener in a dedicated OS identity.
 * @param ctx - Cordis lifecycle owner in the broker-only profile.
 * @param config - Explicit operator-managed configuration.
 * @returns Resolves when ingress is listening; disposal drains it before closing storage.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const origin = new URL(config.publicOrigin)
  if (origin.origin !== config.publicOrigin || origin.username || origin.password
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1'))) {
    throw new Error('publicOrigin must be an exact HTTPS origin, or http://127.0.0.1:<port> for local administration')
  }
  const protectedPaths = [config.stateDirectory, config.encryptionKeyFile, config.executorTokenFile,
    config.adminTokenFile, config.oauthConfigFile]
  for (const path of protectedPaths) {
    if (!isAbsolute(path)) throw new Error('Broker storage and credential paths must be absolute')
  }
  for (const path of [config.executorSocketPath, config.adminSocketPath]) {
    if (path !== undefined && !isAbsolute(path)) throw new Error('Socket paths must be absolute protected Unix paths')
  }
  if (config.executorSocketPath !== undefined && config.executorSocketPath === config.adminSocketPath) {
    throw new Error('Administrative and execution socket paths must differ')
  }
  const secret = readSecret(config.encryptionKeyFile)
  if (!/^[a-fA-F0-9]{64}$/u.test(secret)) throw new Error('encryptionKeyFile must contain exactly 64 hexadecimal characters')
  const key = Buffer.from(secret, 'hex')
  const cursorKey = Buffer.from(hkdfSync('sha256', key, 'mydot-integration-broker:v1', 'pagination', 32))
  await ctx.effect(async () => {
    const store = new BrokerStore(config.stateDirectory, key)
    try {
      const oauth = new BrokerOAuth(store, config.publicOrigin, config.oauthConfigFile, config)
      const runtime = new IntegrationBroker(store, connection => oauth.accessToken(connection), config, cursorKey)
      const server = new BrokerServer(runtime, oauth, config, readSecret(config.executorTokenFile), readSecret(config.adminTokenFile))
      await server.listen()
      return async () => { try { await server.close() } finally { store.close(); key.fill(0); cursorKey.fill(0) } }
    } catch (error) { store.close(); key.fill(0); cursorKey.fill(0); throw error }
  }, 'mydot-integration-broker.listener()')
}

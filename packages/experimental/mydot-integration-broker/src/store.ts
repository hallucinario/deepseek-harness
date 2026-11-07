/** Encrypted SQLite state and durable, non-replaying provider mutation receipts. */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BrokerError } from './errors.ts'
import { responseSchema, stateSchema, type State } from './schema.ts'
import type { BrokerResponse } from './types.ts'

/**
 * Read an operator-provisioned secret without following symlinks or permitting public access.
 * @param path - Absolute regular-file path in an administrator-controlled directory.
 * @returns Trimmed secret value; group read is permitted for a dedicated service group.
 */
export function readSecret(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || (stat.mode & 0o027) !== 0) throw new Error('Secret files must be regular files without group write or public permissions')
    const value = readFileSync(descriptor, 'utf8').trim()
    if (value.length < 32 || value.length > 16_000) throw new Error('Secret length must be between 32 and 16000 characters')
    return value
  } finally { closeSync(descriptor) }
}

/** Durable broker records. SQLite keeps an exclusive process lock and fsyncs each receipt. */
export class BrokerStore {
  /** Decrypted process-local account and permission state; never returned to model callers. */
  readonly state: State
  private readonly database: DatabaseSync
  private healthy = true

  constructor(directory: string, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Broker encryption key must contain exactly 32 bytes')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('Broker state directory must be private (0700)')
    const path = join(directory, 'broker.sqlite')
    const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    closeSync(descriptor)
    if ((lstatSync(path).mode & 0o077) !== 0) throw new Error('Broker database must be private (0600)')
    this.database = new DatabaseSync(path)
    try {
      this.database.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;')
      this.database.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, session TEXT NOT NULL, connection TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL);')
      const row = this.database.prepare('SELECT payload FROM state WHERE id=1').get()
      this.state = row === undefined ? { version: 1, connections: [], grants: [] } : stateSchema.parse(this.decrypt(String(row.payload)))
      this.save()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  /** Persist credentials and policies before publishing their updated state. */
  save(): void {
    this.assertHealthy()
    try {
      stateSchema.parse(this.state)
      this.database.prepare('INSERT INTO state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(this.encrypt(this.state))
    } catch (error) { this.healthy = false; throw error }
  }

  /** Reject further work after persistence failed; a restart reloads only committed permissions. */
  assertHealthy(): void {
    if (!this.healthy) throw new BrokerError('storage_unavailable', 'Broker persistence failed. The operator must restore storage and restart before any further operations.', 503)
  }

  /**
   * Reserve a provider mutation before issuing it, or return its prior outcome.
   * @param id - Hash of Session, account and stable request identity.
   * @param hash - Hash of all mutation fields, rejecting identifier reuse with different input.
   * @returns Prior receipt, or null when this is the first attempt.
   */
  begin(id: string, hash: string): BrokerResponse | null {
    this.assertHealthy()
    const row = this.database.prepare('SELECT hash,payload FROM operations WHERE id=?').get(id)
    if (row !== undefined) {
      if (row.hash !== hash) throw new BrokerError('request_id_reused', 'This request identifier was already used with different arguments.', 409)
      if (row.payload === null) throw new BrokerError('outcome_unknown', 'A previous attempt may have changed the provider. Inspect the account before requesting another change.', 409, 'unknown')
      return responseSchema.parse(this.decrypt(String(row.payload))) as BrokerResponse
    }
    try { this.database.prepare('INSERT INTO operations(id,hash,payload) VALUES(?,?,NULL)').run(id, hash) }
    catch (error) { this.healthy = false; throw error }
    return null
  }

  /**
   * Record a complete sanitized outcome before returning it to the Host.
   * @param id - Reserved operation identifier.
   * @param response - Success or explicit failure to replay on duplicate requests.
   */
  settle(id: string, response: BrokerResponse): void {
    try { this.database.prepare('UPDATE operations SET payload=? WHERE id=?').run(this.encrypt(response), id) }
    catch (error) { this.healthy = false; throw error }
  }

  /**
   * Record metadata without subjects, message content, OAuth tokens or raw Session identifiers.
   * @param session - Originating Session identifier.
   * @param connection - Broker account identifier.
   * @param operation - Closed operation name.
   * @param outcome - Sanitized result code.
   */
  audit(session: string, connection: string, operation: string, outcome: string): void {
    this.assertHealthy()
    try {
      this.database.prepare('INSERT INTO audit(at,session,connection,operation,outcome) VALUES(?,?,?,?,?)')
        .run(Date.now(), createHash('sha256').update(session).digest('hex'), connection, operation, outcome)
    } catch (error) { this.healthy = false; throw error }
  }

  /** Release the database process lock. */
  close(): void { this.database.close() }

  private encrypt(value: unknown): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from('mydot-broker-v1'))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
  }

  private decrypt(value: string): unknown {
    const bytes = Buffer.from(value, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12))
    decipher.setAAD(Buffer.from('mydot-broker-v1'))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
  }
}

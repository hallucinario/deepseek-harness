/** Private Unix listeners; filesystem ownership authenticates the broker to its local clients. */

import { chmod, chown, lstat, unlink } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createConnection } from 'node:net'
import { dirname, isAbsolute } from 'node:path'

/**
 * Bind a private socket in a service-owned directory, refusing unknown or active paths.
 * @param server - Broker-owned HTTP server exposing one transport's routes.
 * @param path - Absolute socket path in a private, non-writable-by-group directory.
 * @param mode - 0660 for the dedicated executor group or 0600 for the administrative proxy.
 * @returns Resolves after the socket has its explicit owner, group and mode.
 */
export async function listenExecutor(server: Server, path: string, mode: 0o600 | 0o660 = 0o660): Promise<void> {
  if (!isAbsolute(path) || process.getuid === undefined) throw new Error('Execution sockets require an absolute POSIX path')
  const parent = await lstat(dirname(path))
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o027) !== 0) {
    throw new Error('The socket directory must be owned by the broker user, without group write or public access')
  }
  const previous = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  })
  if (previous !== undefined) {
    if (!previous.isSocket() || previous.uid !== parent.uid) throw new Error('Refusing to replace an unknown execution socket path')
    await assertStale(path)
    const current = await lstat(path)
    if (current.ino !== previous.ino || current.dev !== previous.dev) throw new Error('Execution socket changed during startup')
    await unlink(path)
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  try {
    await chown(path, parent.uid, parent.gid)
    await chmod(path, mode)
  } catch (error) {
    await closeListener(server)
    throw error
  }
}

/**
 * Stop ingress and all HTTP connections; closing an unbound server is harmless.
 * @param server - Listener owned by this broker instance.
 * @returns Resolves when the listener and its socket path have been released.
 */
export async function closeListener(server: Server): Promise<void> {
  if (!server.listening) return
  const closed = new Promise<void>((resolve, reject) => server.close((error) => {
    if (error) reject(error)
    else resolve()
  }))
  server.closeAllConnections()
  await closed
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function assertStale(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path)
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); reject(new Error('Another broker is using the execution socket')) })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Cannot establish whether the execution socket is stale')) })
    socket.once('error', (error: Error) => {
      socket.destroy()
      if (hasCode(error, 'ECONNREFUSED')) resolve()
      else reject(error)
    })
  })
}

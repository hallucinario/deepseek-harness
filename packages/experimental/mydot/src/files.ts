/** Current UTF-8 files and optimistic writes through the configured filesystem provider. */
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'

import type { TextRead, TextSave, TextSaveResult } from './types.ts'
export type { TextRead, TextSave, TextSaveResult } from './types.ts'

/** Filesystem editor; read and save fail visibly for unsupported or oversized files. */
export class TextFiles {
  constructor(private readonly fs: FileSystem, private readonly maxBytes: number) {}

  /** Read a bounded, consistently versioned text file.
   * @param path - Provider path already authorized by the caller.
   * @returns Current text/version or confirmed absence.
   */
  async read(path: string): Promise<TextRead> {
    const target = await this.fs.resolve(path)
    const before = await this.fs.stat(target)
    if (before === undefined) return { kind: 'missing', path }
    if (before.type !== 'file') throw new Error('Select a regular text file')
    if (before.size !== undefined && before.size > this.maxBytes) throw new Error('File exceeds the text editor limit')
    const content = await this.fs.readText(target)
    if (Buffer.byteLength(content) > this.maxBytes) throw new Error('File exceeds the text editor limit')
    const after = await this.fs.stat(target)
    if (after === undefined || after.version !== before.version) throw new FsError('File changed while reading; reload', 'FS_STALE_VERSION')
    return { kind: 'text', path, content, version: after.version }
  }

  /** Save against an observed version, preserving the draft on conflict.
   * @param request - Authorized path, draft and observed version.
   * @param policy - Existing caller mode and exact authorized workspace; no mode escalation.
   * @returns New version or current contents and unchanged draft on conflict.
   */
  async save(request: TextSave, policy?: Parameters<FileSystem['writeText']>[4]): Promise<TextSaveResult> {
    if (Buffer.byteLength(request.content) > this.maxBytes) throw new Error('Draft exceeds the text editor limit')
    const target = await this.fs.resolve(request.path)
    try {
      const result = await this.fs.writeText(target, request.content, request.version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: request.version }, undefined, policy)
      return { kind: 'saved', path: request.path, version: result.version, content: result.after }
    } catch (error: unknown) {
      if (!(error instanceof FsError) || (error.code !== 'FS_STALE_VERSION' && error.code !== 'FS_NOT_OBSERVED')) throw error
      return { kind: 'conflict', path: request.path, draft: request.content, current: await this.read(request.path) }
    }
  }
}

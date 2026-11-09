/** External GitHub CLI fixture; production lookup, subprocess, and evidence classification remain real. */
import { delimiter, join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export const name = 'mydot-github-fixture'
export const inject = ['subprocess']

export async function apply(ctx, config) {
  await mkdir(config.directory, { recursive: true })
  const source = await readFile(new URL('./gh.mjs', import.meta.url), 'utf8')
  await writeFile(join(config.directory, 'gh'), `#!${process.execPath}\n${source}`, { mode: 0o700 })
  const previous = process.env.PATH
  process.env.PATH = [config.directory, previous].filter(Boolean).join(delimiter)
  ctx.effect(() => () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'PATH')
    else process.env.PATH = previous
  }, 'mydot snapshot: external executable path')
}

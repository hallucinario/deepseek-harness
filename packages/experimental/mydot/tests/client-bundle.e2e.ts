/** Build the actual browser entry: pure Workspace labels must ship in its factory. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('ships the Workspace display fold instead of requiring a nonexistent Client module', async () => {
  const artifact = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  expect(artifact).toContain('__ModuleLoader__.load(')
  expect(artifact).not.toMatch(/require\(["']@deepseek-ai\/dsh-api-workspace-controller\/default-workspace["']\)/)
  expect(artifact).toContain('default-workspace')
})

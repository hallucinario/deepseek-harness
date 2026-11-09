/** A strict read-only external API boundary, copied to the scenario-owned executable directory. */
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (JSON.stringify(args.slice(0, 5)) !== JSON.stringify(['api', '--hostname', 'github.com', '--method', 'GET'])
  || args.length !== 6) throw new Error('Only the declared GitHub GET endpoint is allowed')
const endpoint = args[5]
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'requests.jsonl'), JSON.stringify(args) + '\n')
const prefix = 'repos/owner/repo'
const commit = 'a'.repeat(40)
let response
if (endpoint === `${prefix}/contents/.github/workflows/ci.yml?ref=${commit}`) {
  response = { type: 'file', sha: 'b'.repeat(40) }
} else {
  const match = new RegExp(`^${prefix}/actions/runs/(101|102|103)(/attempts/2/jobs\\?per_page=100&page=1)?$`).exec(endpoint)
  if (match === null) throw new Error(`Undeclared GitHub endpoint: ${endpoint}`)
  const id = Number(match[1])
  if (id === 103) {
    process.stderr.write('External provider is temporarily unavailable\n')
    process.exit(1)
  }
  response = match[2] === undefined
    ? { id, run_attempt: 2, event: 'push', path: '.github/workflows/ci.yml', head_sha: commit,
        repository: { full_name: 'owner/repo' } }
    : { jobs: [{ id: id + 1000, run_id: id, run_attempt: 2, name: 'Lint (Static)', head_sha: commit,
        status: 'completed', conclusion: id === 101 ? 'success' : 'failure' }] }
}
process.stdout.write(JSON.stringify(response))

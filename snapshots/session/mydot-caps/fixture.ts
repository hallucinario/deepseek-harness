/** Wire the MyDot tool into a shipped headless profile without enrolling a Space or starting Caps. */
import type { Context } from '@deepseek-ai/cordis'
import MyDotService from '@deepseek-ai/dsh-experimental-mydot'

/** Fixture for the tool's native Session admission rule. */
export const name = 'snapshot-mydot-caps'

/** Mount MyDot over the profile's durable session and storage services.
 * @param ctx - Shipped headless profile context.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.provide('sessionController', {} as never)
  await ctx.plugin(MyDotService, {
    memoryDirectory: process.cwd(),
    caps: { launcher: process.execPath, workspaceRoots: [process.cwd()], timeoutMs: 5000 },
    maxTextBytes: 262144,
    desktopTools: [],
    captureTools: [],
    summaryCharacters: 240,
  })
}

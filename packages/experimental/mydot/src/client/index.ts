/** Browser entry for the opt-in MyDot composition. */
import type { Context } from '@deepseek-ai/cordis'
import mydotRemote from '@deepseek-ai/dsh-experimental-mydot/remote'
import { mountMyDot } from './mount.ts'

export { inject } from './mount.ts'
export type { MyDotKey } from './locales.ts'

/** Mount MyDot's generated Remote and registered UI.
 * @param ctx - Client Context with declared services.
 * @returns The complete UI/Remote disposer.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> { return mountMyDot(ctx, mydotRemote) }

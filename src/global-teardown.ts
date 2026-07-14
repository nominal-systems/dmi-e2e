import { ChildProcess } from 'child_process'
import { composeDown } from './containers'
import { stopDmiApi } from './dmi-api'
import { env } from './env'
import { closePool } from './sql'

/* Mirrors the declaration in global-setup.ts. Identical `var` declarations in the global scope
 * merge, so neither file has to import the other just to see the handle. */
declare global {
  // eslint-disable-next-line no-var
  var __HARNESS_APP__: ChildProcess | undefined
}

export default async function globalTeardown (): Promise<void> {
  const log = (message: string): void => console.log(`[harness] ${message}`)

  await closePool()

  const app = globalThis.__HARNESS_APP__
  if (app != null) {
    log('stopping dmi-api')
    await stopDmiApi(app)
    globalThis.__HARNESS_APP__ = undefined
  }

  if (env.keepUp) {
    log('HARNESS_KEEP_UP=1 — leaving containers running')
    return
  }

  if (env.manageContainers) {
    log('removing dependency containers and volumes')
    await composeDown(true)
  }
}

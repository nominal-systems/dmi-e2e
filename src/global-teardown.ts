import { ChildProcess } from 'child_process'
import * as path from 'path'
import { composeDown } from './containers'
import { stopDmiApi } from './dmi-api'
import { env } from './env'
import { buildIndex, publish } from './report/report'
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

  /* The reporters have already written reports/<suite>/ (jest runs onRunComplete before
   * globalTeardown). Index it, and publish it when asked. A report problem must not turn a
   * finished run into a failed one — or mask a real red — so it is logged, never thrown. */
  try {
    const index = buildIndex(env.report.dir)
    log(`run report: ${path.join(env.report.dir, env.suite, 'index.html')} (index: ${index})`)
    if (env.report.publish) {
      const { publishDir, published } = publish([env.suite])
      log(`HARNESS_PUBLISH_REPORT=1 — published ${published.join(', ') || 'nothing'} to ${publishDir}`)
    }
  } catch (error) {
    console.error(`[harness] report step failed: ${(error as Error).message}`)
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

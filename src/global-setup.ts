import { ChildProcess } from 'child_process'
import { composeUp, runMigrations, waitForDependencies } from './containers'
import { startDmiApi } from './dmi-api'
import { env } from './env'

/* Jest runs globalSetup and globalTeardown in the same process, so the app handle can be parked
 * on globalThis for teardown to reclaim. Test files run in workers and never see it. */
declare global {
  // eslint-disable-next-line no-var
  var __HARNESS_APP__: ChildProcess | undefined
}

export default async function globalSetup (): Promise<void> {
  const log = (message: string): void => console.log(`[harness] ${message}`)

  if (env.manageContainers) {
    log('starting dependency containers')
    await composeUp()
    log('waiting for MySQL, Mongo and ActiveMQ')
    await waitForDependencies()
    log(`running dmi-api migrations from ${env.dmiApiDir}`)
    await runMigrations()
  } else {
    log('HARNESS_MANAGE_CONTAINERS=0 — assuming dependencies and schema are already up')
  }

  if (env.manageApp) {
    log(`building and starting dmi-api on ${env.baseUrl}`)
    globalThis.__HARNESS_APP__ = await startDmiApi()
    log('dmi-api is healthy')
  } else {
    log(`HARNESS_MANAGE_APP=0 — using the dmi-api already running at ${env.baseUrl}`)
  }
}

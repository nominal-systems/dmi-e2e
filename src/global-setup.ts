import { ChildProcess } from 'child_process'
import { assertProjectIsOurs, composeUp, runMigrations, waitForDependencies } from './containers'
import { assertAppPortFree, startDmiApi } from './dmi-api'
import { env } from './env'
import { beginRun } from './report/report'
import { acquireSlot, releaseSlot } from './slots'

/* Jest runs globalSetup and globalTeardown in the same process, so the app handle can be parked
 * on globalThis for teardown to reclaim. Test files run in workers and never see it. */
declare global {
  // eslint-disable-next-line no-var
  var __HARNESS_APP__: ChildProcess | undefined
}

export default async function globalSetup (): Promise<void> {
  const log = (message: string): void => console.log(`[harness] ${message}`)

  /* The slot before anything else — before the report step below clears reports/<suite>/, which a
   * run already holding this slot from this checkout would still be writing. A taken slot is a
   * loud error naming the run that holds it; teardown releases it. */
  acquireSlot(env.slot, { harnessRoot: env.harnessRoot, dmiApiDir: env.dmiApiDir, buildsDmiApi: env.manageApp && env.build })
  log(`slot ${env.slot} (${env.slotSource}): compose project ${env.composeProject}, dmi-api on port ${env.appPort}`)
  try {
    await setUp(log)
  } catch (error) {
    /* Jest runs no globalTeardown when globalSetup throws, so the slot is given back here rather than
     * left to be found stale later. Containers already started stay up, as they always have after a
     * failed setup; they stay this checkout's, and another checkout's run will not adopt them. */
    releaseSlot(env.slot)
    throw error
  }
}

async function setUp (log: (message: string) => void): Promise<void> {
  /* Before anything else can fail: record what this run is testing and clear the previous run's
   * results, so the report can never show a stale result against a fresh run. */
  const run = beginRun()
  log(`suite '${run.suite}' — under test: ${Object.entries(run.versions).map(([name, version]) => `${name} ${version}`).join(', ')}`)
  log(`from: ${Object.entries(run.locations ?? {}).map(([name, location]) => `${name} ${location}`).join(', ')}`)

  /* Before minutes of containers and migrations: a port taken now would only fail the run later. */
  if (env.manageApp) await assertAppPortFree()

  if (env.manageContainers) {
    await assertProjectIsOurs()
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

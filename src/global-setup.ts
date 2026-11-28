import { ChildProcess } from 'child_process'
import { assertProjectIsOurs, composeUp, projectContainers, runMigrations, waitForDependencies } from './containers'
import { assertAppPortFree, forgetDmiApiProcesses, startDmiApi } from './dmi-api'
import { commonUnderTest, env } from './env'
import { closeMongo, turnOffLeftoverFailPoint } from './mongo'
import { beginRun } from './report/report'
import { unpauseLeftovers, waitForEveryServiceRunning } from './services'
import { acquireSlot, releaseSlot } from './slots'
import { commonCheckout } from './stacks'

/* Jest runs globalSetup and globalTeardown in the same process, so the app handle can be parked
 * on globalThis for teardown to reclaim. Test files never see it: with `maxWorkers: 1` jest runs them
 * in band, in this same process (one pid, measured), but each in a VM context and module registry of
 * its own, whose globalThis is not this one. Hence src/dmi-api.ts's record of every dmi-api a run
 * starts. */
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
  const ignored = commonUnderTest().ignored
  if (ignored != null) log(`${commonCheckout.dirVariable} is set (compose resolves it to ${ignored}), but the fast suite builds no image: ignored`)

  /* Before minutes of containers and migrations: a port taken now would only fail the run later. */
  if (env.manageApp) await assertAppPortFree()

  if (env.manageContainers) {
    await assertProjectIsOurs()
    /* A stack an earlier run left up (HARNESS_KEEP_UP=1) can hold a container that run's scenario
     * had paused when it was killed, and `compose up` refuses one ("cannot start a paused
     * container"). */
    const unpaused = await unpauseLeftovers()
    if (unpaused.length > 0) log(`unpaused ${unpaused.join(', ')}, left paused by an earlier run`)
    /* Likewise its Mongo can still hold the failCommand failpoint that run's scenario had armed
     * (src/mongo.ts), which would fail this run's writes before any scenario armed one. */
    const mongoWasUp = (await projectContainers('mongo')).some((container) => container.state === 'running')
    log('starting dependency containers')
    await composeUp()
    log('waiting for MySQL, Mongo and ActiveMQ')
    await waitForDependencies()
    if (mongoWasUp) {
      try {
        const leftover = await turnOffLeftoverFailPoint()
        if (leftover != null) log(`turned off the Mongo failCommand failpoint an earlier run left armed: ${JSON.stringify(leftover)}`)
      } finally {
        await closeMongo()
      }
    }
    /* Nothing stopped, paused or crash-looping: the scenarios that fault a service start by asserting
     * the stack is whole, and none of them should find it broken by an earlier run. */
    const down = await waitForEveryServiceRunning(env.timeouts.depsReadyMs)
    if (down.length > 0) throw new Error(`containers of ${env.composeProject} are not running: ${JSON.stringify(down)}`)
    log(`running dmi-api migrations from ${env.dmiApiDir}`)
    await runMigrations()
  } else {
    log('HARNESS_MANAGE_CONTAINERS=0 — assuming dependencies and schema are already up')
  }

  if (env.manageApp) {
    log(`building and starting dmi-api on ${env.baseUrl}`)
    /* A new run, a new record of the dmi-api processes it starts (src/dmi-api.ts). Nothing an earlier
     * run recorded is still listening: assertAppPortFree said so above. */
    forgetDmiApiProcesses()
    globalThis.__HARNESS_APP__ = await startDmiApi()
    log('dmi-api is healthy')
  } else {
    log(`HARNESS_MANAGE_APP=0 — using the dmi-api already running at ${env.baseUrl}`)
  }
}

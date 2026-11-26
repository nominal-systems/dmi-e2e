import { execFile, spawn } from 'child_process'
import * as net from 'net'
import { promisify } from 'util'
import { compose, ComposeContainer, projectContainers, waitForHttpOk } from './containers'
import { DmiApiExit, dmiApiGone, runningDmiApi, signalDmiApi, startDmiApi, stopEveryDmiApi } from './dmi-api'
import { env, mockBaseUrlFor } from './env'
import { waitForMysql } from './sql'
import { stacks } from './stacks'

/* Failure injection at the level of the stack: a scenario stops, starts, pauses or restarts one
 * compose service of THIS run's project — the broker (`activemq`), Redis, an engine container — or
 * flushes Redis, or stops dmi-api with a signal, and the harness puts it back. src/mongo.ts's failpoint is the model: a fault is
 * scoped to one target, it is undone by the harness rather than left to the test, and it reports
 * what it reached, so the test can assert that it really fired.
 *
 * Only this run's containers can be reached. Every operation goes through the harness's own compose
 * invocation (`compose()` in src/containers.ts: the files, profile and project composeUp uses, the
 * project named with -p), and is first run in compose's dry-run mode: compose names the containers
 * the command would touch, and the command is refused unless every one of them is a container compose
 * lists for this slot's project. The one operation compose has no command for, pausing a single
 * replica of a replicated service, takes the container's id from that same listing.
 *
 * Nothing stays down. Each fault is entered in a ledger as it is made; `restoreServices()` undoes
 * every entry (a stopped service is started, a paused one unpaused), then waits until compose reports
 * every container of the project running, and checks each restored service answers. A describe that
 * injects faults calls it from `afterEach`, so a test that fails or times out midway still hands the
 * next one a whole stack; the test's own `finally` restores the fault it made as soon as it is done
 * with it. A test takes its controls with `serviceFaults()`, and they stop working when that test
 * ends: a test body jest has abandoned on a timeout cannot fault the stack under the next test.
 * `disrupted()` lists what the ledger holds, and `servicesNotRunning()` what compose reports down,
 * whoever brought it down.
 *
 * Only a stack the harness started. With HARNESS_MANAGE_CONTAINERS=0 the containers are whoever's
 * started them, so stop, pause, restart and flushRedis refuse before they touch anything, naming the
 * variable; with HARNESS_MANAGE_APP=0 stopDmiApi refuses the same way. */

/* The compose services the scenarios fault. The broker keeps ActiveMQ's name in compose (see "The
 * MQTT broker" in the README). */
export const BROKER = 'activemq'
export const REDIS = 'redis'
/* dmi-api is no compose service, it runs on the host (src/dmi-api.ts), but the ledger holds it like
 * one: stopped with a signal, and restored by starting it again from the run's build. */
export const DMI_API = 'dmi-api'

export type ServiceFault = 'stopped' | 'paused'

/* One fault the ledger holds: what was done to which containers, when, and by which test. */
export interface Disruption {
  service: string
  fault: ServiceFault
  /* The replica, when one container of a replicated service was paused on its own. */
  replica?: number
  /* The containers the fault reached, as compose named them (for dmi-api, its process). */
  containers: string[]
  /* dmi-api's: the process the signal was sent to. */
  pid?: number
  since: string
  test: string
}

const ledger = new Map<string, Disruption>()

/* Incremented by restoreServices(): the controls handed out before it are closed. */
let generation = 0

function ledgerKey (service: string, replica?: number): string {
  return replica == null ? service : `${service}#${replica}`
}

function currentTest (): string {
  return typeof expect === 'undefined' ? '(outside a test)' : expect.getState().currentTestName ?? '(outside a test)'
}

/* What this scenario has stopped or paused and not yet restored. */
export function disrupted (): Disruption[] {
  return [...ledger.values()]
}

/* Every container of the project that is not running, as compose reports it: stopped, exited,
 * paused, restarting or never started. Empty on a whole stack. */
export async function servicesNotRunning (): Promise<Array<Pick<ComposeContainer, 'name' | 'service' | 'state' | 'exitCode'>>> {
  return (await projectContainers())
    .filter((container) => container.state !== 'running')
    .map(({ name, service, state, exitCode }) => ({ name, service, state, exitCode }))
}

/* A scenario's starting line: every container of the project running and nothing in the ledger.
 * Throws naming what is not, so a describe that calls it from beforeAll never runs on a stack a
 * previous test (or run) left broken. */
export async function assertStackWhole (): Promise<void> {
  const down = await servicesNotRunning()
  const held = disrupted()
  const dmiApiDown = env.manageApp && runningDmiApi() == null
  if (down.length > 0 || held.length > 0 || dmiApiDown) {
    throw new Error(
      `the stack is not whole before the first fault: ${JSON.stringify({ notRunning: down, faultsNotRestored: held, dmiApiDown })}`,
    )
  }
}

/* The container names a compose command would touch, read from its dry run (` Container <name>
 * <Verb>` lines), after refusing any that is not a container of this run's project. */
async function composeTargets (args: string[]): Promise<string[]> {
  const { stdout, stderr } = await compose(['--dry-run', ...args])
  const named = [...`${stdout}\n${stderr}`.matchAll(/^\s*Container (\S+) \S+/gm)].map((match) => match[1])
  const targets = [...new Set(named)]
  const ours = new Set((await projectContainers()).map((container) => container.name))
  const foreign = targets.filter((name) => !ours.has(name))
  if (foreign.length > 0) {
    throw new Error(
      `refusing \`docker compose ${args.join(' ')}\`: its dry run would also touch ${foreign.join(', ')}, which compose does ` +
        `not list for project ${env.composeProject} (slot ${env.slot})`,
    )
  }
  return targets
}

/* Runs a compose command on this project's containers only (see composeTargets), and returns the
 * containers it touched. */
async function composeOn (args: string[]): Promise<string[]> {
  const targets = await composeTargets(args)
  await compose(args)
  return targets
}

async function knownService (service: string): Promise<ComposeContainer[]> {
  const containers = await projectContainers(service)
  if (containers.length === 0) {
    throw new Error(`compose lists no container of a service '${service}' in project ${env.composeProject} (profile ${stacks[env.stack].composeProfile})`)
  }
  return containers
}

/* One container of a replicated service: compose numbers them from 1 (`<project>-<service>-<n>`). */
async function replicaOf (service: string, replica: number): Promise<ComposeContainer> {
  const containers = await knownService(service)
  const container = containers.find((candidate) => candidate.name === `${env.composeProject}-${service}-${replica}`)
  if (container == null) {
    throw new Error(`${service} has no replica ${replica} in project ${env.composeProject}: ${containers.map((c) => c.name).join(', ')}`)
  }
  return container
}

async function waitForStates (service: string, names: string[], state: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: ComposeContainer[] = []
  while (Date.now() < deadline) {
    last = (await projectContainers(service)).filter((container) => names.includes(container.name))
    if (last.length === names.length && last.every((container) => container.state === state)) return
    await sleep(250)
  }
  throw new Error(`${names.join(', ')} did not reach '${state}' within ${timeoutMs} ms: ${JSON.stringify(last.map(({ name, state }) => ({ name, state })))}`)
}

/* Refuses `what` up front unless the harness started the stack's containers (see the header). */
function requireManagedContainers (what: string): void {
  if (!env.manageContainers) {
    throw new Error(`refusing to ${what}: with HARNESS_MANAGE_CONTAINERS=0 the stack is not the harness's to stop (it did not start it)`)
  }
}

function enter (disruption: Omit<Disruption, 'since' | 'test'>, test: string): Disruption {
  const key = ledgerKey(disruption.service, disruption.replica)
  if (ledger.has(key)) throw new Error(`${key} is already ${ledger.get(key)?.fault}; restore it first`)
  const entry = { ...disruption, since: new Date().toISOString(), test }
  ledger.set(key, entry)
  return entry
}

/* `docker compose stop <service>`: every container of the service, which stays stopped until
 * restored. */
export async function stopService (service: string, test = currentTest()): Promise<Disruption> {
  requireManagedContainers(`stop ${service}`)
  await knownService(service)
  const containers = await composeOn(['stop', service])
  if (containers.length === 0) throw new Error(`compose stopped nothing for ${service}: was it running?`)
  const entry = enter({ service, fault: 'stopped', containers }, test)
  await waitForStates(service, containers, 'exited', 30_000)
  return entry
}

/* `docker compose pause <service>` (every container frozen: its sockets stay open and nothing
 * answers), or, with a replica number, that one container alone: compose's pause has no per-replica
 * form, so the container's id is the one compose lists for that replica. */
export async function pauseService (service: string, options: { replica?: number } = {}, test = currentTest()): Promise<Disruption> {
  const { replica } = options
  requireManagedContainers(`pause ${replica == null ? service : `${service} replica ${replica}`}`)
  let containers: string[]
  if (replica == null) {
    await knownService(service)
    containers = await composeOn(['pause', service])
  } else {
    const container = await replicaOf(service, replica)
    await promisify(execFile)('docker', ['pause', container.id])
    containers = [container.name]
  }
  if (containers.length === 0) throw new Error(`compose paused nothing for ${service}: was it running?`)
  const entry = enter({ service, fault: 'paused', replica, containers }, test)
  await waitForStates(service, containers, 'paused', 30_000)
  return entry
}

/* `docker compose restart <service>`, killing what has not stopped `stopTimeoutS` seconds after
 * its SIGTERM (compose's own default is 10). Not a lasting fault, so nothing is entered in the
 * ledger: a container that does not come back (an engine that refuses to start) is what
 * restoreServices() waits for. */
export async function restartService (service: string, stopTimeoutS = 10): Promise<string[]> {
  requireManagedContainers(`restart ${service}`)
  await knownService(service)
  return await composeOn(['restart', '-t', String(stopTimeoutS), service])
}

/* Sends dmi-api `signal` (SIGTERM, as a pod stop does) and resolves once it has exited (see
 * signalDmiApi). The ledger holds it stopped from the moment the signal is sent, which happens before
 * this returns its promise, so a test can go on with a request in flight while dmi-api shuts down. */
export async function stopDmiApi (signal: NodeJS.Signals = 'SIGTERM', test = currentTest(), timeoutMs = 30_000): Promise<DmiApiExit> {
  if (!env.manageApp) {
    throw new Error('refusing to stop dmi-api: with HARNESS_MANAGE_APP=0 dmi-api is not the harness\'s to stop (it did not start it)')
  }
  const running = runningDmiApi()
  if (running == null) throw new Error('refusing to stop dmi-api: no dmi-api this run started is running')
  enter({ service: DMI_API, fault: 'stopped', containers: [`dmi-api (pid ${running.pid})`], pid: running.pid }, test)
  return await signalDmiApi(signal, timeoutMs)
}

/* dmi-api stopped by stopDmiApi, started again from the run's build, never rebuilt: once the process
 * it signalled is gone, which a restore that comes early (a test that failed right after the signal)
 * gives 15 s, the length of a shutdown cut by its timeout, before it kills it. Unless the test has
 * started another one itself. */
async function startDmiApiAgain (entry: Disruption): Promise<void> {
  if (!(await dmiApiGone(15_000, entry.pid))) await stopEveryDmiApi(entry.pid)
  const running = runningDmiApi()
  if (running != null && running.pid !== entry.pid) return
  await startDmiApi({ build: false, startedBy: `the restore after "${entry.test}"` })
}

/* Undoes one ledger entry and waits until the service answers. Two restores of one entry (a test's
 * own, racing its `finally` or afterEach's) share one undo. */
const undoing = new Map<string, Promise<void>>()

async function undo (entry: Disruption): Promise<void> {
  const key = ledgerKey(entry.service, entry.replica)
  const running = undoing.get(key) ?? undoOnce(entry).finally(() => undoing.delete(key))
  undoing.set(key, running)
  await running
}

async function undoOnce (entry: Disruption): Promise<void> {
  if (entry.service === DMI_API) {
    await startDmiApiAgain(entry)
    ledger.delete(ledgerKey(entry.service))
    return
  }
  const containers = await projectContainers(entry.service)
  const still = containers.filter((container) => entry.containers.includes(container.name) && container.state === (entry.fault === 'stopped' ? 'exited' : 'paused'))
  if (still.length > 0) {
    if (entry.fault === 'stopped') {
      await composeOn(['start', entry.service])
    } else if (entry.replica == null) {
      await composeOn(['unpause', entry.service])
    } else {
      await promisify(execFile)('docker', ['unpause', still[0].id])
    }
  }
  ledger.delete(ledgerKey(entry.service, entry.replica))
  await waitForStates(entry.service, entry.containers, 'running', 60_000)
  await waitForServiceReady(entry.service)
}

/* Restores one fault this scenario made (a no-op if it holds none for that target). */
export async function restoreService (service: string, options: { replica?: number } = {}): Promise<void> {
  const key = ledgerKey(service, options.replica)
  const entry = ledger.get(key)
  if (entry != null) {
    await undo(entry)
  } else {
    await undoing.get(key)
  }
}

/* Undoes every fault in the ledger, newest first, then waits until compose reports every container
 * of the project running and each restored service answering; returns what it restored. Throws if
 * the stack is not whole by then, naming what is still down. Closes the controls handed out by
 * serviceFaults() so far. */
export async function restoreServices (timeoutMs = 120_000): Promise<Disruption[]> {
  generation += 1
  for (const watch of [...watches]) watch.stop()
  const restored = [...ledger.values()].reverse()
  const failures: string[] = []
  for (const entry of restored) {
    try {
      await undo(entry)
    } catch (error) {
      failures.push(`${ledgerKey(entry.service, entry.replica)}: ${(error as Error).message}`)
    }
  }
  /* What the ledger does not hold: a container a test restarted into a crash loop, or one that died
   * of the fault it was given. Compose's restart policy may bring it back by itself. */
  const down = await waitForEveryServiceRunning(timeoutMs)
  if (failures.length > 0 || down.length > 0) {
    throw new Error(`the stack is not whole after restoring ${JSON.stringify(restored)}: ${JSON.stringify({ failures, notRunning: down })}`)
  }
  return restored
}

/* Waits, at most `timeoutMs`, until compose reports every container of the project running, and
 * returns what is still not running then (empty when the stack is whole). */
export async function waitForEveryServiceRunning (timeoutMs: number): Promise<Awaited<ReturnType<typeof servicesNotRunning>>> {
  const deadline = Date.now() + timeoutMs
  let down = await servicesNotRunning()
  while (down.length > 0 && Date.now() < deadline) {
    await sleep(1_000)
    down = await servicesNotRunning()
  }
  return down
}

/* The controls one test uses. They refuse to act once restoreServices() has run after the test (from
 * afterEach): a body jest abandoned on a timeout keeps running, and must not fault the stack under
 * the test after it. */
export interface ServiceFaults {
  stop: (service: string) => Promise<Disruption>
  pause: (service: string, options?: { replica?: number }) => Promise<Disruption>
  restart: (service: string, stopTimeoutS?: number) => Promise<string[]>
  restore: (service: string, options?: { replica?: number }) => Promise<void>
  flushRedis: () => Promise<RedisFlush>
  stopDmiApi: (signal?: NodeJS.Signals) => Promise<DmiApiExit>
}

export function serviceFaults (): ServiceFaults {
  const mine = generation
  const test = currentTest()
  const open = (): void => {
    if (generation !== mine) {
      throw new Error(`the service controls taken by "${test}" are closed: that test has ended, and its stack was restored`)
    }
  }
  return {
    stop: async (service) => { open(); return await stopService(service, test) },
    pause: async (service, options) => { open(); return await pauseService(service, options, test) },
    restart: async (service, stopTimeoutS) => { open(); return await restartService(service, stopTimeoutS) },
    restore: async (service, options) => { await restoreService(service, options) },
    flushRedis: async () => { open(); return await flushRedis() },
    stopDmiApi: async (signal) => { open(); return await stopDmiApi(signal, test) },
  }
}

/* ---- Redis -------------------------------------------------------------------------------- */

/* `redis-cli <args>` inside the project's Redis container (no client library needed), returning its
 * raw output. */
export async function redisCli (...args: string[]): Promise<string> {
  await knownService(REDIS)
  const { stdout } = await compose(['exec', '-T', REDIS, 'redis-cli', '--raw', ...args])
  return stdout.trim()
}

export interface RedisFlush {
  keysBefore: number
  keysAfter: number
}

/* FLUSHALL on the project's Redis: every Bull queue, repeatable job and lock of every integration is
 * gone, as after a cutover to an empty instance. Reports the key counts on either side, so a test can
 * assert that there was something to lose. */
export async function flushRedis (): Promise<RedisFlush> {
  requireManagedContainers('flush Redis')
  const keysBefore = Number(await redisCli('DBSIZE'))
  const reply = await redisCli('FLUSHALL')
  if (reply !== 'OK') throw new Error(`FLUSHALL answered '${reply}'`)
  return { keysBefore, keysAfter: Number(await redisCli('DBSIZE')) }
}

/* The members of every Bull repeat registry (`<prefix>:<queue>:repeat`, a sorted set per queue) that
 * name `jobId`: a repeatable job is registered under its id, which the integrations make the dmi
 * integration id. */
export async function repeatableJobsNaming (jobId: string): Promise<Array<{ registry: string, member: string }>> {
  const registries = (await redisCli('--scan', '--pattern', '*:repeat')).split('\n').filter((line) => line !== '')
  const found: Array<{ registry: string, member: string }> = []
  for (const registry of registries) {
    for (const member of (await redisCli('ZRANGE', registry, '0', '-1')).split('\n')) {
      if (member.includes(jobId)) found.push({ registry, member })
    }
  }
  return found
}

/* Whether Redis answers a PING on its published host port within `timeoutMs`. A paused container
 * still accepts the connection (the kernel does that) and never answers, which is what a test asserts
 * to show its pause took. */
export async function redisAnswers (timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: env.redis.hostname, port: env.redis.port })
    let reply = ''
    const done = (answered: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(answered)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => socket.write('PING\r\n'))
    socket.on('data', (chunk) => {
      reply += chunk.toString()
      if (reply.includes('\r\n')) done(reply.startsWith('+PONG'))
    })
    socket.once('error', () => done(false))
  })
}

/* ---- readiness ---------------------------------------------------------------------------- */

/* After a service is started or unpaused: running is not answering, so each service the scenarios
 * fault is asked as its clients ask it. A service with no probe here (an engine) is ready once
 * compose reports it running; the scenario's next round trip is its proof. */
async function waitForServiceReady (service: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  /* Each throws until the service answers. */
  const probe = async (): Promise<void> => {
    if (service === REDIS) {
      const { stdout } = await compose(['exec', '-T', REDIS, 'redis-cli', 'PING'])
      if (stdout.trim() !== 'PONG') throw new Error(`redis-cli PING answered '${stdout.trim()}'`)
    } else if (service === BROKER) {
      /* A publish nobody receives, from inside the container: it succeeds once mosquitto takes MQTT. */
      await compose(['exec', '-T', BROKER, 'mosquitto_pub', '-h', '127.0.0.1', '-t', 'dmi-e2e/readiness', '-n'])
    } else if (service === 'mysql') {
      await waitForMysql(5_000)
    } else if (service === stacks[env.stack].mock.label) {
      await waitForHttpOk(`${mockBaseUrlFor(env.stack)}/status`, service, 5_000)
    }
  }
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await probe()
      return
    } catch (error) {
      lastError = error
    }
    await sleep(500)
  }
  throw new Error(`${service} did not answer within ${timeoutMs} ms after it was restored: ${String(lastError)}`)
}

/* ---- what an engine did ------------------------------------------------------------------ */

/* Watches the service's containers for exits, from Docker's event stream (the `die` events of the
 * container ids compose lists for the service): `codes` collects each exit code as it happens. A
 * container under a restart policy is up again before its state could be read, and the daemon keeps
 * too few past events (a few hundred, for every container on the machine) to be asked afterwards.
 * `stop()` ends the watch; restoreServices() ends any a test left running. */
export interface ExitWatch {
  codes: number[]
  stop: () => void
}

const watches = new Set<ExitWatch>()

export async function watchExits (service: string): Promise<ExitWatch> {
  const containers = await knownService(service)
  const child = spawn('docker', [
    'events',
    /* From a second ago, so that the moment the stream takes to open is covered by the daemon's own
     * record. */
    '--since', ((Date.now() - 1_000) / 1000).toFixed(3),
    ...containers.flatMap((container) => ['--filter', `container=${container.id}`]),
    '--filter', 'event=die',
    '--format', '{{.Actor.Attributes.exitCode}}',
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  const watch: ExitWatch = {
    codes: [],
    stop: () => {
      watches.delete(watch)
      child.kill()
    },
  }
  let leftover = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    const lines = (leftover + chunk.toString()).split(/\r?\n/)
    leftover = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') watch.codes.push(Number(line.trim()))
  })
  watches.add(watch)
  return watch
}

/* Everything the service's containers logged since `sinceMs`, without compose's prefixes. */
export async function serviceLogs (service: string, sinceMs: number): Promise<string> {
  await knownService(service)
  const { stdout } = await compose(['logs', '--no-color', '--no-log-prefix', '--since', new Date(sinceMs).toISOString(), service])
  return stdout
}

/* ---- a kept-up stack ---------------------------------------------------------------------- */

/* Before a run's containers are started: a stack a previous run left up (HARNESS_KEEP_UP=1) may
 * still hold a container a scenario had paused when that run was killed, and `compose up` refuses a
 * paused container. Unpauses each, and returns their names. */
export async function unpauseLeftovers (): Promise<string[]> {
  const paused = (await projectContainers()).filter((container) => container.state === 'paused')
  for (const service of new Set(paused.map((container) => container.service))) await composeOn(['unpause', service])
  return paused.map((container) => container.name)
}

export async function sleep (ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

import { spawn } from 'child_process'
import * as net from 'net'
import { appEnv, env, requireDmiApiDir } from './env'
import { waitForMysql } from './sql'

/* Lifecycle for the dependency stack (MySQL, Mongo, ActiveMQ) and for dmi-api's schema
 * migrations. Process orchestration may invoke dmi-api's own npm scripts — the black-box rule
 * constrains test code, not how the environment is brought up. */

/* Node >= 20.12 refuses to spawn .cmd/.bat without a shell (CVE-2024-27980). Docker is a real
 * executable and needs no shell; npm on Windows is npm.cmd and does. */
const isWindows = process.platform === 'win32'

interface RunOptions {
  cwd: string
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  /* Buffer the child's output instead of inheriting it, and print only the tail if it fails.
   * dmi-api's migrations emit ~176k lines of TypeORM query logging on a cold database; inheriting
   * that floods the run and buries everything else. */
  capture?: boolean
}

async function run (command: string, args: string[], options: RunOptions): Promise<void> {
  const { cwd, environment, timeoutMs, capture } = options
  const useShell = isWindows && command === 'npm'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(useShell ? 'npm.cmd' : command, args, {
      cwd,
      env: environment ?? process.env,
      stdio: capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: useShell,
      timeout: timeoutMs,
    })

    /* Bounded ring buffer of the last output lines, so capturing a huge log costs no real memory. */
    let tail: string[] = []
    let leftover = ''
    const collect = (chunk: Buffer): void => {
      const lines = (leftover + chunk.toString()).split(/\r?\n/)
      leftover = lines.pop() ?? ''
      tail.push(...lines)
      if (tail.length > 400) tail = tail.slice(-400)
    }
    if (capture === true) {
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
    }

    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      if (capture === true && tail.length > 0) {
        process.stderr.write(`\n--- last output of \`${command} ${args.join(' ')}\` ---\n`)
        process.stderr.write(tail.join('\n') + '\n---\n')
      }
      /* code is null when the process was killed by a signal (e.g. the spawn timeout). */
      const how = code == null ? `signal ${String(signal)} (likely the ${String(timeoutMs)}ms timeout)` : `code ${String(code)}`
      reject(new Error(`${command} ${args.join(' ')} exited with ${how}`))
    })
  })
}

async function waitForTcp (
  host: string,
  port: number,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host, port })
        socket.setTimeout(3000)
        socket.once('connect', () => {
          socket.destroy()
          resolve()
        })
        socket.once('timeout', () => {
          socket.destroy()
          reject(new Error('timeout'))
        })
        socket.once('error', (error) => {
          socket.destroy()
          reject(error)
        })
      })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error(`${label} at ${host}:${port} not ready within ${timeoutMs}ms: ${String(lastError)}`)
}

/* Full-system services live behind compose profiles, so the default fast suite brings up only
 * MySQL/Mongo/ActiveMQ. Each full-system loop has its own profile: `idexx` (redis + the VetConnect
 * Plus mock + the real idexx integration), `antech` (redis + the Antech mock + the real classic
 * antech integration), `zoetis` (redis + the Zoetis mock + the real zoetis integration) and
 * `full-stack` (redis + the demo vendor + its MySQL + the demo integration).
 * `--profile` is a top-level flag and must precede the subcommand. */
function composeProfile (): string {
  if (env.stack === 'demo') return 'full-stack'
  return env.stack
}

function composeBaseArgs (): string[] {
  const args = ['compose', '-f', env.composeFile]
  if (env.fullStack) args.push('--profile', composeProfile())
  return args
}

export async function composeUp (): Promise<void> {
  /* `--build` in full-stack mode: the two integration/vendor images are built from their own
   * (Node-14-era) Dockerfiles, which need a GHP_TOKEN build-arg to reach GitHub Packages. Layer
   * caching keeps rebuilds cheap after the first. Give the first cold build a generous budget. */
  const args = [...composeBaseArgs(), 'up', '-d']
  if (env.fullStack) args.push('--build')
  await run('docker', args, {
    cwd: env.harnessRoot,
    timeoutMs: env.fullStack ? 900_000 : 300_000,
  })
}

export async function composeDown (removeVolumes: boolean): Promise<void> {
  const args = [...composeBaseArgs(), 'down']
  if (removeVolumes) args.push('-v')
  await run('docker', args, { cwd: env.harnessRoot, timeoutMs: 120_000 })
}

/* Poll an HTTP endpoint until it answers 2xx. Used for the demo-provider vendor, whose port opens
 * only after its NestJS app has connected to its own MySQL (TypeORM is in the module graph), so a
 * 2xx from /status means "really ready", not merely "port bound". */
async function waitForHttpOk (url: string, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`${label} at ${url} not ready within ${timeoutMs}ms: ${String(lastError)}`)
}

/* Polled rather than slept: generous readiness timeouts, no fixed sleeps. MySQL is the slow one —
 * mysql:8 bounces the server once during first-boot initialisation. In full-stack mode the demo
 * vendor is added: the harness mints an API key from it during seeding, so it must be up first.
 * (Redis and the demo integration have no harness-facing endpoint; the broker/queue clients inside
 * the integration reconnect on their own, and the scenario's completion wait absorbs their start.) */
export async function waitForDependencies (): Promise<void> {
  const { depsReadyMs } = env.timeouts
  const mongo = new URL(env.mongoUri)
  await waitForMysql(depsReadyMs)
  /* A mongodb:// URI may omit the port, in which case URL.port is '' and Number('') is 0. */
  await waitForTcp(mongo.hostname, Number(mongo.port !== '' ? mongo.port : 27017), 'Mongo', depsReadyMs)
  await waitForTcp(env.activemq.hostname, env.activemq.port, 'ActiveMQ', depsReadyMs)
  if (env.fullStack) {
    /* The vendor the harness talks to during seeding must be up first: the mock-backed modes drive
     * the mock's control plane, and its /status opens only once the mock is listening; demo mode
     * mints an API key from the demo vendor. Redis and the integration containers have no
     * harness-facing endpoint — their broker/queue clients reconnect on their own and the scenario's
     * completion wait absorbs their start. */
    if (env.stack === 'demo') {
      await waitForHttpOk(`${env.demoProvider.baseUrl}/status`, 'demo-provider-api', depsReadyMs)
    } else if (env.stack === 'antech') {
      await waitForHttpOk(`${env.antech.mockBaseUrl}/status`, 'antech-mock', depsReadyMs)
    } else if (env.stack === 'zoetis') {
      await waitForHttpOk(`${env.zoetis.mockBaseUrl}/status`, 'zoetis-mock', depsReadyMs)
    } else {
      await waitForHttpOk(`${env.idexx.mockBaseUrl}/status`, 'vetconnect-mock', depsReadyMs)
    }
  }
}

/* Running dmi-api's migrations explicitly also regression-tests that they produce a working schema
 * from empty — which nothing in dmi-api checks. Output is captured (not inherited): a cold run
 * emits ~176k lines of query logging, shown only if migrations fail. */
export async function runMigrations (): Promise<void> {
  await run('npm', ['run', 'migration:run'], {
    cwd: requireDmiApiDir(),
    environment: appEnv(),
    timeoutMs: env.timeouts.migrationsMs,
    capture: true,
  })
}

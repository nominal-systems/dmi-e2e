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

async function run (
  command: string,
  args: string[],
  { cwd, environment, timeoutMs }: { cwd: string, environment?: NodeJS.ProcessEnv, timeoutMs?: number },
): Promise<void> {
  const useShell = isWindows && command === 'npm'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(useShell ? 'npm.cmd' : command, args, {
      cwd,
      env: environment ?? process.env,
      stdio: 'inherit',
      shell: useShell,
      timeout: timeoutMs,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${String(code)}`))
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

export async function composeUp (): Promise<void> {
  await run('docker', ['compose', '-f', env.composeFile, 'up', '-d'], {
    cwd: env.harnessRoot,
    timeoutMs: 300_000,
  })
}

export async function composeDown (removeVolumes: boolean): Promise<void> {
  const args = ['compose', '-f', env.composeFile, 'down']
  if (removeVolumes) args.push('-v')
  await run('docker', args, { cwd: env.harnessRoot, timeoutMs: 120_000 })
}

/* Polled rather than slept: generous readiness timeouts, no fixed sleeps. MySQL is the slow one —
 * mysql:8 bounces the server once during first-boot initialisation. */
export async function waitForDependencies (): Promise<void> {
  const { depsReadyMs } = env.timeouts
  const mongo = new URL(env.mongoUri)
  await waitForMysql(depsReadyMs)
  /* A mongodb:// URI may omit the port, in which case URL.port is '' and Number('') is 0. */
  await waitForTcp(mongo.hostname, Number(mongo.port !== '' ? mongo.port : 27017), 'Mongo', depsReadyMs)
  await waitForTcp(env.activemq.hostname, env.activemq.port, 'ActiveMQ', depsReadyMs)
}

/* Running dmi-api's migrations explicitly also regression-tests that they produce a working schema
 * from empty — which nothing in dmi-api checks. */
export async function runMigrations (): Promise<void> {
  await run('npm', ['run', 'migration:run'], {
    cwd: requireDmiApiDir(),
    environment: appEnv(),
    timeoutMs: 300_000,
  })
}

import { ChildProcess, spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import * as net from 'net'
import * as path from 'path'
import { appEnv, env, requireDmiApiDir } from './env'
import { lockFile } from './slots'

/* Lifecycle for the system under test. dmi-api runs on the host, from a checkout located by
 * DMI_API_DIR, against containerised dependencies. Building its Docker image instead would need a
 * GHP_TOKEN at image-build time on every run, for no extra coverage.
 *
 * `node dist/main` rather than `npm run start`: `nest start` forks a child, and killing a process
 * tree portably (Windows especially) is a reliable source of orphaned servers holding the port. */

const isWindows = process.platform === 'win32'

async function buildDmiApi (dmiApiDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(isWindows ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: dmiApiDir,
      stdio: 'inherit',
      shell: isWindows,
      timeout: 600_000,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      code === 0 ? resolve() : reject(new Error(`npm run build exited with code ${String(code)}`))
    })
  })
}

/* dmi-api's registerStaticAssets points @fastify/static at <repo>/public, which is absent from a
 * clean checkout — the Admin UI is built into it by dmi-api's release workflow. Without this the
 * app throws on boot. Creating the directory is exactly what that workflow does.
 *
 * This writes into the dmi-api checkout. It creates one empty, gitignored-irrelevant directory and
 * nothing else; it is the only write this harness makes there. */
function ensurePublicDir (dmiApiDir: string): void {
  const publicDir = path.join(dmiApiDir, 'public')
  if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true })
}

export async function waitForHealth (
  timeoutMs: number,
  app?: ChildProcess,
  spawnError?: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    const failure = spawnError?.()
    if (failure != null) throw failure
    if (app?.exitCode != null) {
      throw new Error(`dmi-api exited with code ${app.exitCode} before becoming healthy`)
    }
    try {
      const response = await fetch(`${env.baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`dmi-api at ${env.baseUrl} not healthy within ${timeoutMs}ms: ${String(lastError)}`)
}

/* Refuses to start dmi-api where something already listens. waitForHealth takes any 2xx from
 * /health as this run's dmi-api, so a dmi-api left running by a killed harness run — or anything
 * else answering on that port — would stand in for this checkout's build, and the suite would test
 * it instead, quite possibly green. Checked when setup starts and again just before the spawn. */
export async function assertAppPortFree (): Promise<void> {
  const { hostname, port } = new URL(env.baseUrl)
  const inUse = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: hostname, port: Number(port) })
    socket.setTimeout(2000)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
  if (inUse) {
    throw new Error(
      `something is already listening on ${hostname}:${port}, where slot ${env.slot} starts dmi-api — most likely a dmi-api ` +
        'that a killed harness run left behind. Starting anyway would test whatever answers there instead of this ' +
        `checkout's build. Stop it (\`ss -ltnp 'sport = :${port}'\` or \`lsof -i :${port}\` names its pid), or use another slot.`,
    )
  }
}

/* Builds (unless HARNESS_BUILD=0, or `build: false`) and starts dmi-api, waits for /health, and
 * records the process (see "which dmi-api is running" below). `startedBy` names who started it:
 * global setup, or the test that started it again after stopping it. */
export async function startDmiApi (options: { startedBy?: string, build?: boolean } = {}): Promise<ChildProcess> {
  const dmiApiDir = requireDmiApiDir()
  await assertAppPortFree()
  ensurePublicDir(dmiApiDir)
  if (options.build ?? env.build) await buildDmiApi(dmiApiDir)

  const entrypoint = path.join(dmiApiDir, 'dist', 'main.js')
  if (!existsSync(entrypoint)) {
    throw new Error(`${entrypoint} not found. Run 'npm run build' in dmi-api, or set HARNESS_BUILD=1.`)
  }

  const app = spawn(process.execPath, [entrypoint], {
    cwd: dmiApiDir,
    env: appEnv(),
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  track(app, options.startedBy ?? 'global setup')

  /* Throwing from an 'error' listener would surface as an uncaught exception in Jest's
   * globalSetup, losing the cause. Stash it and let waitForHealth report it. */
  let spawnError: Error | undefined
  app.on('error', (error) => {
    spawnError = error
  })

  await waitForHealth(env.timeouts.appReadyMs, app, () => spawnError)
  return app
}

export async function stopDmiApi (app: ChildProcess): Promise<void> {
  if (app.exitCode != null || app.signalCode != null) return
  await new Promise<void>((resolve) => {
    app.once('close', () => resolve())

    /* The process may have exited between the guard above and the listener above, in which case
     * 'close' has already fired and will not fire again. */
    if (app.exitCode != null || app.signalCode != null) {
      resolve()
      return
    }

    /* SIGTERM is not really supported on Windows; Node maps kill() onto TerminateProcess. That is
     * fine here because a single `node dist/main` has no children to orphan. */
    app.kill('SIGTERM')
    setTimeout(() => {
      if (app.exitCode == null) app.kill('SIGKILL')
    }, 10_000).unref()
  })
}
/* ---- which dmi-api is running ------------------------------------------------------------- */

/* One dmi-api process this run started, and how it ended. */
export interface DmiApiProcess {
  pid: number
  startedAt: string
  /* 'global setup', or the test that started it again. */
  startedBy: string
  /* As its parent process saw it (the process that spawned it records it). */
  exit?: { code: number | null, signal: string | null, at: string }
}

/* Global setup starts dmi-api in jest's main process, and a scenario runs in a jest worker or, in
 * band, in a module registry of its own: neither can see the other's process handle. So every
 * dmi-api the run starts is recorded in a file of the slot's, beside its lock (src/slots.js), with
 * its exit as its parent saw it. A scenario stops the one that is running by its pid and starts
 * another, and global teardown stops whatever the file says is still running, whoever started it. */
function processesFile (): string {
  return path.join(path.dirname(lockFile(env.slot)), `slot-${env.slot}.dmi-api.json`)
}

export function dmiApiProcesses (): DmiApiProcess[] {
  try {
    const parsed = JSON.parse(readFileSync(processesFile(), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeProcesses (processes: DmiApiProcess[]): void {
  const file = processesFile()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(processes, null, 2) + '\n')
  renameSync(`${file}.tmp`, file)
}

/* A new run starts a new record. */
export function forgetDmiApiProcesses (): void {
  writeProcesses([])
}

function track (app: ChildProcess, startedBy: string): void {
  const pid = app.pid
  if (pid == null) return
  writeProcesses([...dmiApiProcesses(), { pid, startedAt: new Date().toISOString(), startedBy }])
  app.once('exit', (code, signal) => {
    writeProcesses(dmiApiProcesses().map((entry) => entry.pid === pid ? { ...entry, exit: { code, signal, at: new Date().toISOString() } } : entry))
  })
}

/* Whether `pid` is still the dmi-api this run started: alive, and (where /proc says) still running
 * the checkout's entrypoint, so that a pid the system has since given to another process is never
 * signalled. */
function isOurDmiApi (pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  if (!existsSync('/proc/self/cmdline')) return true
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(path.join(env.dmiApiDir, 'dist', 'main.js'))
  } catch {
    return false
  }
}

/* The dmi-api this run has running: the newest one started whose exit is not recorded and whose
 * process is still there. */
export function runningDmiApi (): DmiApiProcess | undefined {
  return dmiApiProcesses().filter((entry) => entry.exit == null && isOurDmiApi(entry.pid)).pop()
}

export interface DmiApiExit {
  pid: number
  signal: NodeJS.Signals
  /* From the signal to the exit its parent recorded (or to the pid disappearing, when nothing was
   * recorded: a parent that died first). */
  exitedAfterMs: number
  code: number | null
  exitSignal: string | null
}

/* Sends `signal` to the dmi-api this run has running (SIGTERM: what a pod stop sends) and waits for
 * it to exit, at most `timeoutMs`, after which it is killed and this throws. */
export async function signalDmiApi (signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 30_000): Promise<DmiApiExit> {
  const running = runningDmiApi()
  if (running == null) throw new Error(`no dmi-api of this run is running (${processesFile()}: ${JSON.stringify(dmiApiProcesses())})`)
  const signalledAt = Date.now()
  process.kill(running.pid, signal)
  const deadline = signalledAt + timeoutMs
  while (Date.now() < deadline) {
    const exit = dmiApiProcesses().find((entry) => entry.pid === running.pid)?.exit
    if (exit != null) {
      return { pid: running.pid, signal, exitedAfterMs: Date.parse(exit.at) - signalledAt, code: exit.code, exitSignal: exit.signal }
    }
    if (!isOurDmiApi(running.pid)) return { pid: running.pid, signal, exitedAfterMs: Date.now() - signalledAt, code: null, exitSignal: null }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  process.kill(running.pid, 'SIGKILL')
  throw new Error(`dmi-api (pid ${running.pid}) had not exited ${timeoutMs} ms after ${signal}; killed`)
}

/* Stops every dmi-api this run started that is still alive — the one global setup started and any a
 * scenario started again — with SIGTERM, then SIGKILL after 15 s. Global teardown's, so that no run
 * leaves a dmi-api holding its slot's port. Returns the pids it stopped. */
export async function stopEveryDmiApi (): Promise<number[]> {
  const alive = dmiApiProcesses().filter((entry) => isOurDmiApi(entry.pid))
  for (const { pid } of alive) process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 15_000
  while (alive.some(({ pid }) => isOurDmiApi(pid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
  for (const { pid } of alive) if (isOurDmiApi(pid)) process.kill(pid, 'SIGKILL')
  return alive.map(({ pid }) => pid)
}

/* ---- dmi-api's own scripts ----------------------------------------------------------------- */

export interface DmiApiScriptRun {
  /* null when the script was killed (its signal is then set). */
  code: number | null
  signal: string | null
  output: string[]
  ms: number
}

/* Runs one of dmi-api's npm scripts (`npm run <script> -- <args>`) from the checkout under test,
 * with the environment the app runs with (appEnv, plus `environment`): its own process against the
 * same database and broker, as an operator runs one beside a deployment. `onLine` sees each line of
 * its output as it arrives, so a test can act at a given point of the script's run. Killed after
 * `timeoutMs`. */
export async function runDmiApiScript (
  script: string,
  args: string[],
  options: { timeoutMs: number, onLine?: (line: string) => void, environment?: Record<string, string> },
): Promise<DmiApiScriptRun> {
  const started = Date.now()
  const child = spawn(isWindows ? 'npm.cmd' : 'npm', ['run', script, '--', ...args], {
    cwd: requireDmiApiDir(),
    /* Nest's logger colours its output unless NO_COLOR is set; plain lines are what a test reads. */
    env: { ...appEnv(), NO_COLOR: '1', ...options.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
  })
  const output: string[] = []
  const reader = (stream: NodeJS.ReadableStream | null): void => {
    let leftover = ''
    const emit = (line: string): void => {
      output.push(line)
      options.onLine?.(line)
    }
    stream?.on('data', (chunk: Buffer) => {
      const lines = (leftover + chunk.toString()).split(/\r?\n/)
      leftover = lines.pop() ?? ''
      lines.forEach(emit)
    })
    stream?.on('end', () => {
      if (leftover !== '') emit(leftover)
    })
  }
  reader(child.stdout)
  reader(child.stderr)
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
  return await new Promise<DmiApiScriptRun>((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, output, ms: Date.now() - started })
    })
  })
}

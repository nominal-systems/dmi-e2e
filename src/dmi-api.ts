import { ChildProcess, spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import * as path from 'path'
import { appEnv, env, requireDmiApiDir } from './env'

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

export async function startDmiApi (): Promise<ChildProcess> {
  const dmiApiDir = requireDmiApiDir()
  ensurePublicDir(dmiApiDir)
  if (env.build) await buildDmiApi(dmiApiDir)

  const entrypoint = path.join(dmiApiDir, 'dist', 'main.js')
  if (!existsSync(entrypoint)) {
    throw new Error(`${entrypoint} not found. Run 'npm run build' in dmi-api, or set HARNESS_BUILD=1.`)
  }

  const app = spawn(process.execPath, [entrypoint], {
    cwd: dmiApiDir,
    env: appEnv(),
    stdio: ['ignore', 'inherit', 'inherit'],
  })

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

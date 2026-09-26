'use strict'

/* Harness slots — what lets several harness runs share one machine without touching each other.
 *
 * A run is a compose project (containers, network, named volumes, locally built images) plus a
 * set of host ports: dmi-api runs on the host and reaches MySQL, Mongo and the broker through
 * published ports, and the scenarios drive each mock through its published port. Two runs that
 * share either collide — and not always loudly. Two runs under one project name do not fail to
 * start: the second ADOPTS the first's containers, migrates into its database, and its teardown
 * (`down -v`) deletes that database mid-run. Two dmi-api instances on one broker are one MQTT
 * shared-subscription group (`$share/dmi-api/…`, a constant in dmi-api), so the broker
 * load-balances each run's results into the other's dmi-api. Neither shows up in a serial run.
 *
 * A slot is a small integer that moves a run off every shared resource at once:
 *   - every host port is its default + STRIDE × slot, and
 *   - the compose project is `dmi-e2e` for slot 0 and `dmi-e2e-s<n>` otherwise,
 * so slot 0 is exactly the harness as it always ran. The slot comes from HARNESS_SLOT, else from a
 * `.harness-slot` file in the checkout's root, else it is 0 — it belongs to the checkout, so a
 * checkout made for slot 3 runs as slot 3 without anyone remembering to say so.
 *
 * applySlot() writes the slot's ports and project name INTO process.env (never over a value that
 * is already set: an explicit HARNESS_*_PORT still wins). That is deliberate: the harness hands
 * process.env to every `docker compose` it runs, and docker-compose.yml takes each published port
 * from `${HARNESS_*_PORT:-default}` and the project from COMPOSE_PROJECT_NAME — so the containers
 * and the harness read the same values from one place. Shifting only the harness's own copies
 * would move the host side while the containers stayed on the defaults, and the harness would talk
 * confidently to whichever stack owns them.
 *
 * A lock per slot (acquireSlot) makes a second run on a taken slot a loud error naming the holder,
 * instead of two runs sharing a database. The locks live outside any checkout, in one directory per
 * user, so runs from different checkouts see each other's.
 *
 * Plain CommonJS for the same reason as src/stacks.js: jest.config.js runs verifySlots() before
 * ts-jest exists, and scripts/slot-tree.sh asks the CLI at the bottom for project names, ports and
 * lock holders rather than restating them. */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { stacks } = require('./stacks')
/* eslint-enable @typescript-eslint/no-var-requires */

/* Ports move in steps of ten. The 30xx group (dmi-api and the mocks) is 3010–3016 today, so a new
 * mock takes the next free port below 3020; verifySlots() refuses a table where any two ports meet
 * in any pair of slots up to MAX_SLOT, which is what "the step is wide enough" actually means. */
const STRIDE = 10
const MAX_SLOT = 99
const BASE_PROJECT = 'dmi-e2e'

/* Every host port a run binds or dials, except the loops' mocks, which the stack registry lists
 * (each entry's `mock.portVariable` / `mock.defaultPort`). The defaults are restated once more in
 * docker-compose.yml's `${VAR:-default}` so a bare `docker compose` still works; verifySlots()
 * holds the two in step. dmi-api's port has no compose entry: dmi-api is a host process. */
const basePorts = [
  { variable: 'HARNESS_APP_PORT', defaultPort: 3010, label: 'dmi-api' },
  { variable: 'HARNESS_MYSQL_PORT', defaultPort: 3307, label: 'MySQL' },
  { variable: 'HARNESS_MONGO_PORT', defaultPort: 27018, label: 'Mongo' },
  { variable: 'HARNESS_ACTIVEMQ_PORT', defaultPort: 1884, label: 'MQTT broker' },
  { variable: 'HARNESS_REDIS_PORT', defaultPort: 6380, label: 'Redis' },
  { variable: 'HARNESS_DEMO_MYSQL_PORT', defaultPort: 3308, label: 'demo-provider MySQL' },
]

/* The whole table: the base ports, then one per registry mock. */
function hostPorts () {
  return [
    ...basePorts,
    ...Object.values(stacks).map(({ mock }) => ({ variable: mock.portVariable, defaultPort: mock.defaultPort, label: mock.label })),
  ]
}

/* @param {number} slot */
function projectName (slot) {
  return slot === 0 ? BASE_PROJECT : `${BASE_PROJECT}-s${slot}`
}

/* @param {number} slot */
function portsFor (slot) {
  return hostPorts().map((entry) => ({ ...entry, port: entry.defaultPort + STRIDE * slot }))
}

/* Validates a slot number from wherever it came, naming the source when it is not one.
 * @param {string} value @param {string} source @returns {number} */
function parseSlot (value, source) {
  if (!/^\d+$/.test(value) || Number(value) > MAX_SLOT) {
    throw new Error(`${source} must be a whole number from 0 to ${MAX_SLOT}; got '${value}'`)
  }
  return Number(value)
}

/* HARNESS_SLOT, else the checkout's `.harness-slot`, else 0.
 * @param {NodeJS.ProcessEnv} environment @param {string} harnessRoot
 * @returns {{ slot: number, source: string }} */
function resolveSlot (environment, harnessRoot) {
  const raw = environment.HARNESS_SLOT
  if (raw != null && raw !== '') return { slot: parseSlot(raw.trim(), 'HARNESS_SLOT'), source: 'HARNESS_SLOT' }
  const file = path.join(harnessRoot, '.harness-slot')
  if (fs.existsSync(file)) return { slot: parseSlot(fs.readFileSync(file, 'utf8').trim(), file), source: '.harness-slot' }
  return { slot: 0, source: 'default' }
}

/* Resolves the slot and writes its project name and every port that is not already set into
 * `environment` (process.env, in the harness). Refuses a COMPOSE_PROJECT_NAME that disagrees with
 * the slot: the lock, the adoption check and every compose call assume the project is the slot's.
 * That refusal also catches an inherited environment — a process that already applied slot 0 and
 * spawns a run for slot 3 hands it slot 0's ports as if they were explicit overrides; the project
 * name it hands over with them gives it away.
 * @param {NodeJS.ProcessEnv} environment @param {string} harnessRoot
 * @returns {{ slot: number, source: string, project: string }} */
function applySlot (environment, harnessRoot) {
  const { slot, source } = resolveSlot(environment, harnessRoot)
  const project = projectName(slot)
  const current = environment.COMPOSE_PROJECT_NAME
  if (current != null && current !== '' && current !== project) {
    throw new Error(
      `COMPOSE_PROJECT_NAME is '${current}', but slot ${slot} (from ${source}) runs as '${project}'. ` +
        'The harness names the compose project after the slot: unset COMPOSE_PROJECT_NAME and choose the slot with HARNESS_SLOT.',
    )
  }
  environment.COMPOSE_PROJECT_NAME = project
  for (const { variable, port } of portsFor(slot)) {
    if (environment[variable] == null || environment[variable] === '') environment[variable] = String(port)
  }
  return { slot, source, project }
}

/* ---- the lock ------------------------------------------------------------------------------ */

/* One directory per user, outside every checkout, so a run in one checkout sees a run in another.
 * HARNESS_LOCK_DIR moves it (tests, or a machine where the home directory is not shared by the
 * runs that share its Docker). */
function lockDir (environment = process.env) {
  const configured = environment.HARNESS_LOCK_DIR
  return path.resolve(configured != null && configured !== '' ? configured : path.join(os.homedir(), '.cache', 'dmi-e2e', 'slot-locks'))
}

function lockFile (slot, environment = process.env) {
  return path.join(lockDir(environment), `slot-${slot}.lock`)
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    /* EPERM: it exists, it just is not ours to signal. */
    return error.code === 'EPERM'
  }
}

function readHolder (file) {
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Number.isInteger(holder?.pid) ? holder : undefined
  } catch {
    return undefined
  }
}

/* The live holder of a slot's lock, or undefined when the slot is free (no lock, or its holder is
 * gone). */
function slotHolder (slot, environment = process.env) {
  const holder = readHolder(lockFile(slot, environment))
  return holder != null && isAlive(holder.pid) ? holder : undefined
}

/* Takes the slot for this process, or throws naming whoever has it. A lock whose process is gone
 * (a run that crashed or was killed — jest runs no teardown when setup throws) is reclaimed. The
 * file is created O_EXCL, so of two runs racing for a free slot exactly one wins.
 * @param {number} slot @param {string} harnessRoot */
function acquireSlot (slot, harnessRoot, environment = process.env) {
  const file = lockFile(slot, environment)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const mine = JSON.stringify({ pid: process.pid, harnessRoot, since: new Date().toISOString() }) + '\n'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' })
      return file
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const holder = readHolder(file)
    if (holder == null) {
      /* Unreadable: either half-written by a run taking it this instant, or debris. */
      let ageMs = Infinity
      try { ageMs = Date.now() - fs.statSync(file).mtimeMs } catch { /* gone meanwhile */ }
      if (ageMs < 10_000) throw new Error(`slot ${slot} is being taken by another run right now (${file})`)
    } else if (isAlive(holder.pid)) {
      throw new Error(
        `slot ${slot} is taken: pid ${holder.pid} has held it since ${holder.since}, running from ${holder.harnessRoot}. ` +
          'Two runs on one slot would share one database. Pick another slot (HARNESS_SLOT, or .harness-slot in the checkout) ' +
          `or wait for that run to finish. If pid ${holder.pid} is not a harness run, delete ${file}.`,
      )
    }
    fs.rmSync(file, { force: true })
  }
  throw new Error(`could not take ${file}: another run keeps taking slot ${slot} at the same moment`)
}

/* Releases the slot if this process holds it — never another run's lock. */
function releaseSlot (slot, environment = process.env) {
  const file = lockFile(slot, environment)
  if (readHolder(file)?.pid === process.pid) fs.rmSync(file, { force: true })
}

/* ---- consistency --------------------------------------------------------------------------- */

/* Checks docker-compose.yml against the port table, and the table against itself, throwing with
 * every problem named. jest.config.js runs it at load, next to verifyStacks(). What it catches:
 *   - a published port that no slot can move (a literal `3000:3000`, or a variable the table does
 *     not list) — two slots would both bind it;
 *   - a compose default that disagrees with the table — slot 0 would stop being what a bare
 *     `docker compose up` gives;
 *   - two ports meeting in any pair of slots up to MAX_SLOT, or a port past 65535;
 *   - an image named with a literal `dmi-e2e-` prefix — compose names the images it builds after
 *     the project unless told otherwise, and a fixed name makes every slot build and run ONE tag:
 *     a run gets whichever slot built last, silently;
 *   - a project `name:` other than slot 0's. */
function verifySlots () {
  const root = path.resolve(__dirname, '..')
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
  const problems = []
  const table = hostPorts()

  const byVariable = new Map()
  for (const entry of table) {
    if (byVariable.has(entry.variable)) problems.push(`${entry.variable} is in the port table twice`)
    byVariable.set(entry.variable, entry)
  }

  const published = new Set()
  for (const block of compose.matchAll(/^\s*ports:\s*\n((?:[ \t]+-[^\n]*\n)+)/gm)) {
    for (const item of block[1].matchAll(/^[ \t]+-\s*(.+?)\s*$/gm)) {
      const spec = item[1].replace(/^['"]|['"]$/g, '')
      const match = /^\$\{([A-Z][A-Z0-9_]*):-(\d+)\}:\d+$/.exec(spec)
      if (match == null) {
        problems.push(`docker-compose.yml publishes '${spec}': every host port must be '\${HARNESS_<NAME>_PORT:-<default>}:<container port>' so a slot can move it`)
        continue
      }
      const [, variable, fallback] = match
      published.add(variable)
      const entry = byVariable.get(variable)
      if (entry == null) {
        problems.push(`docker-compose.yml publishes ${variable}, which no slot moves — add it to basePorts in src/slots.js (or, for a mock, to its registry entry)`)
      } else if (entry.defaultPort !== Number(fallback)) {
        problems.push(`${variable} defaults to ${fallback} in docker-compose.yml but ${entry.defaultPort} in the port table`)
      }
    }
  }
  for (const { variable } of table) {
    if (variable !== 'HARNESS_APP_PORT' && !published.has(variable)) {
      problems.push(`${variable} is in the port table but docker-compose.yml publishes no such port`)
    }
  }

  const owner = new Map()
  for (let slot = 0; slot <= MAX_SLOT; slot++) {
    for (const { variable, port } of portsFor(slot)) {
      if (port > 65535) problems.push(`${variable} is ${port} in slot ${slot}, past the last port`)
      const other = owner.get(port)
      if (other != null) problems.push(`port ${port} is ${other.variable} in slot ${other.slot} and ${variable} in slot ${slot}`)
      else owner.set(port, { variable, slot })
    }
  }

  for (const image of compose.matchAll(/^\s*image:\s*['"]?(dmi-e2e[^'"\s]*)/gm)) {
    problems.push(`image '${image[1]}' is a fixed name: every slot would build and run the same tag — name it \${COMPOSE_PROJECT_NAME:-${BASE_PROJECT}}-<name>`)
  }
  const name = /^name:\s*['"]?([^'"\s]+)/m.exec(compose)?.[1]
  if (name !== BASE_PROJECT) problems.push(`docker-compose.yml's project name is '${name}', not '${BASE_PROJECT}' — slot 0 would not be the project a bare \`docker compose\` uses`)

  if (problems.length > 0) {
    throw new Error(`harness slots (src/slots.js) are inconsistent with docker-compose.yml:\n  - ${problems.join('\n  - ')}`)
  }
}

module.exports = {
  STRIDE,
  MAX_SLOT,
  hostPorts,
  projectName,
  portsFor,
  parseSlot,
  resolveSlot,
  applySlot,
  lockFile,
  slotHolder,
  acquireSlot,
  releaseSlot,
  verifySlots,
}

/* CLI for shell callers (scripts/slot-tree.sh), so no script restates the table:
 *   node src/slots.js project <n>   → the compose project slot <n> runs as (exit 1 if <n> is no slot)
 *   node src/slots.js ports <n>     → one "<variable> <port> <label>" line per host port
 *   node src/slots.js holder <n>    → "<pid> <since> <checkout>" when a live run holds slot <n>;
 *                                     nothing when it is free
 *   node src/slots.js check         → verifySlots(), exit 1 with the problems if any */
if (require.main === module) {
  const [command, value] = process.argv.slice(2)
  try {
    if (command === 'project') {
      console.log(projectName(parseSlot(String(value ?? ''), 'slot')))
    } else if (command === 'ports') {
      console.log(portsFor(parseSlot(String(value ?? ''), 'slot')).map(({ variable, port, label }) => `${variable} ${port} ${label}`).join('\n'))
    } else if (command === 'holder') {
      const holder = slotHolder(parseSlot(String(value ?? ''), 'slot'))
      if (holder != null) console.log(`${holder.pid} ${holder.since} ${holder.harnessRoot}`)
    } else if (command === 'check') {
      verifySlots()
      console.log(`harness slots ok: ${hostPorts().length} host ports, slots 0–${MAX_SLOT}`)
    } else {
      throw new Error('usage: node src/slots.js project <n> | ports <n> | holder <n> | check')
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

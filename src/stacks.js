'use strict'

/* The stack registry — the one place that knows what each full-system loop is made of. Every
 * consumer derives from it: jest.config.js (which scenario file to run, the poll-budget class, the
 * report suite name), src/env.ts (validation of HARNESS_STACK, the checkouts the run report
 * records, the mock's host-facing URL), src/containers.ts (compose profile, readiness),
 * src/report/report.ts (suite order) and scripts/nightly.sh (which checkouts to pull, via the CLI
 * at the bottom). Adding a loop is one entry here plus its compose profile, scenario and workflow
 * — never another if/else keyed on the stack name — and `verifyStacks()` below checks that the
 * entry and those three artefacts agree, every time the harness starts.
 *
 * Plain CommonJS on purpose: jest.config.js is loaded before ts-jest exists, so this cannot be
 * TypeScript (hence the require() exemption below — the lint rule assumes an ES-module world).
 * src/env.ts imports it under `allowJs`, and its `StackName` type is `keyof typeof stacks` —
 * derived from this object, not restated.
 *
 * The stack key is the harness's name for a loop — the HARNESS_STACK value, the report suite, the
 * workflow, the compose profile, the mock (`<key>-mock`, CLAUDE.md) and the env prefix — and is
 * distinct from `providerId`, dmi-api's id for the provider. They coincide for most loops, but a
 * provider with several API generations gets one dmi-api id per generation (`antech` is classic
 * Antech, V3; `antech-v6` the next), and the harness keys the classic loop `antech-v3` so that
 * nothing derived from the key — files, env variables, the workflow's `paths:` glob — can be
 * mistaken for the V6 loop's. Keys must not be prefixes of one another for the same reason
 * (`verifyStacks()` refuses that). `providerId` has no reader yet: each scenario still carries
 * its own literal (`providerId: 'idexx'` in the seed options), so the two must be kept in step
 * by hand until the first consumer makes the scenarios read it from here. */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs')
const path = require('path')
/* eslint-enable @typescript-eslint/no-var-requires */

const stacks = {
  idexx: {
    providerId: 'idexx',
    scenario: 'scenarios/idexx-full-stack.e2e.ts',
    composeProfile: 'idexx',
    /* The sibling checkouts this loop's containers are built from: for a loop like this one, the
     * real integration's repo; for a loop hosted by a shared engine container, the host repo plus
     * the provider module(s) injected into it. Each variable overrides that checkout's location,
     * with the same default docker-compose.yml uses, and the run report records every one of them.
     * Several loops may list the same checkout (same repo, same variable): the nightly pulls it
     * once, and `verifyStacks()` refuses a variable that names different repos in different loops. */
    checkouts: [{ repo: 'dmi-engine-idexx-integration', dirVariable: 'DMI_IDEXX_INTEGRATION_DIR' }],
    /* The mock's host-facing endpoint: its published port, the URL variable that overrides the
     * whole thing, and the name readiness logs call it. Readiness is `<baseUrl>/status`. One name
     * per mock: label, urlVariable and portVariable all derive from `<stack>-mock` (CLAUDE.md). */
    mock: {
      label: 'idexx-mock',
      urlVariable: 'HARNESS_IDEXX_MOCK_URL',
      portVariable: 'HARNESS_IDEXX_MOCK_PORT',
      defaultPort: 3012,
      pathPrefix: '',
    },
    /* idexx exposes IDEXX_*_POLLING_INTERVAL_MS, which the harness dials down to ~3s. */
    slowPoll: false,
  },
  'antech-v3': {
    /* Classic Antech. dmi-api's id for the provider is the bare `antech` (it predates V6); the
     * harness key carries the generation, see the header. The integration repo keeps its own
     * name too — it is `dmi-engine-antech-integration` on GitHub. */
    providerId: 'antech',
    scenario: 'scenarios/antech-v3-full-stack.e2e.ts',
    composeProfile: 'antech-v3',
    checkouts: [{ repo: 'dmi-engine-antech-integration', dirVariable: 'DMI_ANTECH_V3_INTEGRATION_DIR' }],
    mock: {
      label: 'antech-v3-mock',
      urlVariable: 'HARNESS_ANTECH_V3_MOCK_URL',
      portVariable: 'HARNESS_ANTECH_V3_MOCK_PORT',
      defaultPort: 3013,
      pathPrefix: '',
    },
    /* The integration hardcodes its Bull poll interval to 30s with no env knob: a result can sit
     * for a full tick before the engine picks it up, so the per-test budget absorbs a missed one
     * rather than reading a healthy-but-slow loop as a hang. */
    slowPoll: true,
  },
  zoetis: {
    providerId: 'zoetis',
    scenario: 'scenarios/zoetis-full-stack.e2e.ts',
    composeProfile: 'zoetis',
    checkouts: [{ repo: 'dmi-engine-zoetis-integration', dirVariable: 'DMI_ZOETIS_INTEGRATION_DIR' }],
    mock: {
      label: 'zoetis-mock',
      urlVariable: 'HARNESS_ZOETIS_MOCK_URL',
      portVariable: 'HARNESS_ZOETIS_MOCK_PORT',
      defaultPort: 3014,
      pathPrefix: '',
    },
    /* Hardcoded 30s poll, as antech-v3. */
    slowPoll: true,
  },
  demo: {
    providerId: 'demo',
    scenario: 'scenarios/full-stack-smoke.e2e.ts',
    composeProfile: 'full-stack',
    checkouts: [{
      repo: 'dmi-engine-demo-provider-integration',
      dirVariable: 'DMI_DEMO_INTEGRATION_DIR',
    }],
    /* Not a mock but the demo provider itself (dmi-demo-provider-api), under its `/demo` global
     * prefix. The harness mints an API key from it during seeding, so it must be up first. */
    mock: {
      label: 'demo-provider-api',
      urlVariable: 'HARNESS_DEMO_PROVIDER_URL',
      portVariable: 'HARNESS_DEMO_PROVIDER_PORT',
      defaultPort: 3011,
      pathPrefix: '/demo',
    },
    slowPoll: false,
  },
}

/* The loop HARNESS_FULL_STACK=1 runs when HARNESS_STACK is unset. */
const defaultStack = 'idexx'

/* Validates a raw HARNESS_STACK value against the registry. Both parsers — jest.config.js and
 * src/env.ts — go through here, so an unknown value is refused by both; one can no longer
 * silently coerce a typo to the default loop while the other throws.
 * @param {string | undefined} raw
 * @returns {keyof typeof stacks} */
function resolveStack (raw) {
  const value = raw == null || raw === '' ? defaultStack : String(raw).toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(stacks, value)) {
    throw new Error(`HARNESS_STACK must be one of ${Object.keys(stacks).join(', ')}; got '${raw}'`)
  }
  return /** @type {keyof typeof stacks} */ (value)
}

/* Short name of the jest suite an invocation runs: 'fast', or the stack under
 * HARNESS_FULL_STACK=1. Names the run's report directory (reports/<suite>/).
 * @param {boolean} fullStack
 * @param {keyof typeof stacks} stack */
function suiteName (fullStack, stack) {
  return fullStack ? stack : 'fast'
}

/* Checks that every entry agrees with the artefacts it points at, and throws naming the loop and
 * the field otherwise. A registry key can be validated when HARNESS_STACK is read, but a wrong
 * field inside an entry fails late and misleadingly without this: a scenario path that does not
 * exist is jest's generic "No tests found"; a compose profile nobody declares boots MySQL, Mongo
 * and ActiveMQ alone and surfaces as a readiness timeout naming the mock; a scenario renamed out
 * of its workflow's `paths:` glob keeps every check green while the workflow silently stops
 * triggering. jest.config.js runs this at load, so every run — local or CI — trips on a bad entry
 * before anything is built. `node src/stacks.js check` runs it by hand. */
function verifyStacks () {
  const root = path.resolve(__dirname, '..')
  const problems = []
  const fail = (key, field, problem) => problems.push(`${key}.${field}: ${problem}`)

  /* Every profile any service declares, so a profile that would start nothing is caught. */
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
  const declaredProfiles = new Set()
  for (const list of compose.matchAll(/profiles:\s*\[([^\]]*)\]/g)) {
    for (const name of list[1].matchAll(/'([^']+)'/g)) declaredProfiles.add(name[1])
  }

  for (const [key, entry] of Object.entries(stacks)) {
    /* Keys are used as env-var suffixes only through `dirVariable`, never derived, so hyphens are
     * fine; anything beyond lowercase words is not (they name compose profiles, suites, files). */
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) fail(key, 'key', 'must be lowercase letters, digits and hyphens')
    if (typeof entry.providerId !== 'string' || entry.providerId === '') fail(key, 'providerId', 'missing')
    if (!fs.existsSync(path.join(root, entry.scenario))) fail(key, 'scenario', `no such file: ${entry.scenario}`)
    if (!declaredProfiles.has(entry.composeProfile)) {
      fail(key, 'composeProfile', `'${entry.composeProfile}' is declared by no service in docker-compose.yml (declared: ${[...declaredProfiles].sort().join(', ')})`)
    }
    if (!Array.isArray(entry.checkouts) || entry.checkouts.length === 0) {
      fail(key, 'checkouts', 'must list at least one sibling checkout')
    } else {
      const variables = new Set()
      entry.checkouts.forEach((checkout, i) => {
        const variable = checkout?.dirVariable ?? ''
        if (typeof checkout?.repo !== 'string' || checkout.repo === '') fail(key, `checkouts[${i}].repo`, 'missing')
        if (!/^[A-Z][A-Z0-9_]*$/.test(variable)) {
          fail(key, `checkouts[${i}].dirVariable`, 'must be an environment variable name')
        } else if (!compose.includes(`\${${variable}`)) {
          /* A checkout the run report records must be an input to some image build, or its
           * "under test" row is decorative — a version nothing ran. */
          fail(key, `checkouts[${i}].dirVariable`, `${variable} is referenced by no build context in docker-compose.yml — the run report would record a checkout nothing is built from`)
        }
        if (variables.has(variable)) fail(key, 'checkouts', `${variable} is listed twice`)
        variables.add(variable)
      })
    }
    for (const field of ['label', 'urlVariable', 'portVariable']) {
      if (typeof entry.mock?.[field] !== 'string' || entry.mock[field] === '') fail(key, `mock.${field}`, 'missing')
    }
    if (!Number.isInteger(entry.mock?.defaultPort)) fail(key, 'mock.defaultPort', 'must be an integer')
    if (typeof entry.mock?.pathPrefix !== 'string') fail(key, 'mock.pathPrefix', "must be a string ('' for none)")
    if (typeof entry.slowPoll !== 'boolean') fail(key, 'slowPoll', 'must be a boolean')

    /* A loop with its own workflow must keep its scenario inside the workflow's `paths:` glob —
     * the glob is `scenarios/<key>*.e2e.ts` by convention, so the scenario must start with the
     * key. A loop without a workflow (demo, dispatch-only) is exempt. */
    const workflow = path.join(root, '.github', 'workflows', `e2e-${key}.yml`)
    if (fs.existsSync(workflow)) {
      const text = fs.readFileSync(workflow, 'utf8')
      const glob = `scenarios/${key}*.e2e.ts`
      if (!text.includes(`'${glob}'`)) fail(key, 'workflow', `e2e-${key}.yml does not filter on '${glob}'`)
      if (!(entry.scenario.startsWith(`scenarios/${key}`) && entry.scenario.endsWith('.e2e.ts'))) {
        fail(key, 'scenario', `${entry.scenario} is outside the workflow glob '${glob}'`)
      }
      /* CI must point every checkout variable at the checkout it made. Compose's `../<repo>`
       * defaults happen to coincide with the runner's workspace layout, so a variable the workflow
       * forgot would keep CI green while testing whatever the default resolves to. */
      for (const { dirVariable } of Array.isArray(entry.checkouts) ? entry.checkouts : []) {
        if (typeof dirVariable === 'string' && !text.includes(`${dirVariable}:`)) fail(key, 'workflow', `e2e-${key}.yml does not set ${dirVariable}`)
      }
    }
  }

  /* Across loops. A checkout shared by several loops is ONE checkout: a variable must always name
   * the same repo, or two loops would pull and record different things under one location. And
   * since every workflow's `paths:` glob is `scenarios/<key>*.e2e.ts`, a key that is a prefix of
   * another key's would fire its workflow on the other loop's scenario edits too — the reason the
   * classic Antech loop is `antech-v3` and not `antech` beside `antech-v6`. */
  const repoOf = new Map()
  const mockNameOwner = new Map()
  const keys = Object.keys(stacks)
  for (const key of keys) {
    for (const { repo, dirVariable } of Array.isArray(stacks[key].checkouts) ? stacks[key].checkouts : []) {
      const other = repoOf.get(dirVariable)
      if (other != null && other.repo !== repo) fail(key, 'checkouts', `${dirVariable} names ${repo} here but ${other.repo} in ${other.key}`)
      repoOf.set(dirVariable, { key, repo })
    }
    /* One name per mock (CLAUDE.md) also means one mock per name: two loops sharing a label or a
     * variable would read each other's endpoint. */
    for (const field of ['label', 'urlVariable', 'portVariable']) {
      const value = stacks[key].mock?.[field]
      if (typeof value !== 'string') continue
      const owner = mockNameOwner.get(`${field}=${value}`)
      if (owner != null && owner !== key) fail(key, `mock.${field}`, `'${value}' is also ${owner}'s`)
      mockNameOwner.set(`${field}=${value}`, key)
    }
    for (const otherKey of keys) {
      if (otherKey !== key && otherKey.startsWith(key)) {
        fail(key, 'key', `is a prefix of '${otherKey}' — the workflow glob 'scenarios/${key}*.e2e.ts' would match ${otherKey}'s scenario too`)
      }
    }
  }

  /* The validator itself: a registry whose gate stopped throwing would pass everything above. */
  let refused = false
  try { resolveStack('no-such-stack') } catch { refused = true }
  if (!refused) problems.push("resolveStack: accepted 'no-such-stack' — the HARNESS_STACK gate is open")

  if (problems.length > 0) {
    throw new Error(`stack registry (src/stacks.js) is inconsistent:\n  - ${problems.join('\n  - ')}`)
  }
}

module.exports = { stacks, defaultStack, resolveStack, suiteName, verifyStacks }

/* CLI for shell callers (scripts/nightly.sh), so no script re-derives what the registry knows:
 *   node src/stacks.js list                → one key per line
 *   node src/stacks.js checkouts <key>     → one "<repo> <dirVariable>" line per checkout the loop
 *                                            is built from — exit 1 naming the key if unknown
 *   node src/stacks.js check               → verifyStacks(), exit 1 with the problems if any */
if (require.main === module) {
  const [command, key] = process.argv.slice(2)
  try {
    if (command === 'list') {
      console.log(Object.keys(stacks).join('\n'))
    } else if (command === 'checkouts') {
      const { checkouts } = stacks[resolveStack(key)]
      console.log(checkouts.map(({ repo, dirVariable }) => `${repo} ${dirVariable}`).join('\n'))
    } else if (command === 'check') {
      verifyStacks()
      console.log(`stack registry ok: ${Object.keys(stacks).join(', ')}`)
    } else {
      throw new Error('usage: node src/stacks.js list | checkouts <key> | check')
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

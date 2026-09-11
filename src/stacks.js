'use strict'

/* The stack registry — the one place that knows what each full-system loop is made of. Every
 * consumer derives from it: jest.config.js (which scenario file to run, the poll-budget class, the
 * report suite name), src/env.ts (validation of HARNESS_STACK, the integration checkout the run
 * report records, the mock's host-facing URL), src/containers.ts (compose profile, readiness),
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
 * The stack key is the harness's name for a loop (the HARNESS_STACK value, the report suite, the
 * workflow) and is distinct from `providerId`, dmi-api's id for the provider. They coincide today,
 * but a vendor with several API generations gets one dmi-api id per generation (`antech`,
 * `antech-v6`) while the harness may want a different key for the classic loop (`antech-v3`), and
 * two stacks may be served by one integration container. Keep both. `providerId` has no reader
 * yet: each scenario still carries its own literal (`providerId: 'idexx'` in the seed options),
 * so the two must be kept in step by hand until the first consumer — the shared-container work —
 * makes the scenarios read it from here. */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs')
const path = require('path')
/* eslint-enable @typescript-eslint/no-var-requires */

const stacks = {
  idexx: {
    providerId: 'idexx',
    scenario: 'scenarios/idexx-full-stack.e2e.ts',
    composeProfile: 'idexx',
    /* The real integration container is built from this sibling checkout — the variable overrides
     * the location, with the same default docker-compose.yml uses — and the run report records
     * its version. */
    integration: { repo: 'dmi-engine-idexx-integration', dirVariable: 'DMI_IDEXX_INTEGRATION_DIR' },
    /* The mock's host-facing endpoint: its published port, the URL variable that overrides the
     * whole thing, and the name readiness logs call it. Readiness is `<baseUrl>/status`. */
    mock: {
      label: 'vetconnect-mock',
      urlVariable: 'HARNESS_VCP_MOCK_URL',
      portVariable: 'HARNESS_VCP_MOCK_PORT',
      defaultPort: 3012,
      pathPrefix: '',
    },
    /* idexx exposes IDEXX_*_POLLING_INTERVAL_MS, which the harness dials down to ~3s. */
    slowPoll: false,
  },
  antech: {
    providerId: 'antech',
    scenario: 'scenarios/antech-full-stack.e2e.ts',
    composeProfile: 'antech',
    integration: { repo: 'dmi-engine-antech-integration', dirVariable: 'DMI_ANTECH_INTEGRATION_DIR' },
    mock: {
      label: 'antech-mock',
      urlVariable: 'HARNESS_ANTECH_MOCK_URL',
      portVariable: 'HARNESS_ANTECH_MOCK_PORT',
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
    integration: { repo: 'dmi-engine-zoetis-integration', dirVariable: 'DMI_ZOETIS_INTEGRATION_DIR' },
    mock: {
      label: 'zoetis-mock',
      urlVariable: 'HARNESS_ZOETIS_MOCK_URL',
      portVariable: 'HARNESS_ZOETIS_MOCK_PORT',
      defaultPort: 3014,
      pathPrefix: '',
    },
    /* Hardcoded 30s poll, as antech. */
    slowPoll: true,
  },
  demo: {
    providerId: 'demo',
    scenario: 'scenarios/full-stack-smoke.e2e.ts',
    composeProfile: 'full-stack',
    integration: {
      repo: 'dmi-engine-demo-provider-integration',
      dirVariable: 'DMI_DEMO_INTEGRATION_DIR',
    },
    /* Not a mock but the demo vendor itself (dmi-demo-provider-api), under its `/demo` global
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
    if (typeof entry.integration?.repo !== 'string' || entry.integration.repo === '') fail(key, 'integration.repo', 'missing')
    if (!/^[A-Z][A-Z0-9_]*$/.test(entry.integration?.dirVariable ?? '')) fail(key, 'integration.dirVariable', 'must be an environment variable name')
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
      const glob = `scenarios/${key}*.e2e.ts`
      if (!fs.readFileSync(workflow, 'utf8').includes(`'${glob}'`)) fail(key, 'workflow', `e2e-${key}.yml does not filter on '${glob}'`)
      if (!(entry.scenario.startsWith(`scenarios/${key}`) && entry.scenario.endsWith('.e2e.ts'))) {
        fail(key, 'scenario', `${entry.scenario} is outside the workflow glob '${glob}'`)
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
 *   node src/stacks.js integration <key>   → "<repo> <dirVariable>" — exit 1 naming the key if unknown
 *   node src/stacks.js check               → verifyStacks(), exit 1 with the problems if any */
if (require.main === module) {
  const [command, key] = process.argv.slice(2)
  try {
    if (command === 'list') {
      console.log(Object.keys(stacks).join('\n'))
    } else if (command === 'integration') {
      const { integration } = stacks[resolveStack(key)]
      console.log(`${integration.repo} ${integration.dirVariable}`)
    } else if (command === 'check') {
      verifyStacks()
      console.log(`stack registry ok: ${Object.keys(stacks).join(', ')}`)
    } else {
      throw new Error('usage: node src/stacks.js list | integration <key> | check')
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

'use strict'

/* The stack registry — the one place that knows what each full-system loop is made of. Every
 * consumer derives from it: jest.config.js (which scenario file to run, the poll-budget class, the
 * report suite name), src/env.ts (validation of HARNESS_STACK, the integration checkout the run
 * report records, the mock's host-facing URL), src/containers.ts (compose profile, readiness) and
 * src/report/report.ts (suite order). Adding a loop is one entry here plus its compose profile,
 * scenario and workflow — never another if/else keyed on the stack name.
 *
 * Plain CommonJS on purpose: jest.config.js is loaded before ts-jest exists, so this cannot be
 * TypeScript. src/env.ts imports it under `allowJs`, and its `StackName` type is
 * `keyof typeof stacks` — derived from this object, not restated.
 *
 * The stack key is the harness's name for a loop (the HARNESS_STACK value, the report suite, the
 * workflow) and is distinct from `providerId`, dmi-api's id for the provider. They coincide today,
 * but a vendor with several API generations gets one dmi-api id per generation (`antech`,
 * `antech-v6`) while the harness may want a different key for the classic loop (`antech-v3`), and
 * two stacks may be served by one integration container. Keep both. */

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

module.exports = { stacks, defaultStack, resolveStack, suiteName }

/* Two jest projects, mutually exclusive because they run dmi-api under different NODE_ENVs (seed vs
 * normal) and so cannot share one app process:
 *
 *   - fast (default):      smoke + tenant-isolation, dmi-api alone under NODE_ENV=seed.
 *   - full-stack:          a real provider loop, dmi-api under a normal NODE_ENV against the real
 *                          engine/vendor stack. Selected by HARNESS_FULL_STACK=1; HARNESS_STACK then
 *                          picks WHICH loop — 'idexx' (default: idexx integration + VetConnect Plus
 *                          mock) runs scenarios/idexx-full-stack.e2e.ts; 'antech' (classic antech
 *                          integration + Antech mock) runs scenarios/antech-full-stack.e2e.ts;
 *                          'zoetis' (zoetis integration + Zoetis mock) runs
 *                          scenarios/zoetis-full-stack.e2e.ts; 'demo' (upstream-blocked) runs
 *                          scenarios/full-stack-smoke.e2e.ts.
 *
 * Only the selected project is included, so globalSetup/globalTeardown (which read env.fullStack /
 * env.stack to bring up the right containers and app env) run exactly once per run. Global options
 * (globalSetup, globalTeardown, maxWorkers, testTimeout, verbose) live at the root — jest ignores
 * them inside a project config; only test-selection options are per-project. Scoped to scenarios/ so
 * the helpers in src/ are never picked up as test files. */
const fullStack =
  process.env.HARNESS_FULL_STACK === '1' ||
  (process.env.HARNESS_FULL_STACK ?? '').toLowerCase() === 'true'
const requestedStack = (process.env.HARNESS_STACK ?? 'idexx').toLowerCase()
const stack = ['demo', 'antech', 'zoetis'].includes(requestedStack) ? requestedStack : 'idexx'

const scenarioForStack = {
  demo: '<rootDir>/scenarios/full-stack-smoke.e2e.ts',
  antech: '<rootDir>/scenarios/antech-full-stack.e2e.ts',
  zoetis: '<rootDir>/scenarios/zoetis-full-stack.e2e.ts',
  idexx: '<rootDir>/scenarios/idexx-full-stack.e2e.ts',
}

/* The two loops whose integrations hardcode their Bull poll interval to 30s with no env knob (idexx
 * exposes IDEXX_*_POLLING_INTERVAL_MS, which the harness dials down to ~3s). A result can sit for a
 * full interval before the engine picks it up, so their default per-test budget is raised to absorb
 * a missed tick rather than let a healthy-but-slow loop read as a hang. */
const slowPollStacks = ['antech', 'zoetis']

const projectCommon = {
  rootDir: __dirname,
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
}

const fastProject = {
  ...projectCommon,
  displayName: 'fast',
  testMatch: [
    '<rootDir>/scenarios/smoke.e2e.ts',
    '<rootDir>/scenarios/tenant-isolation.e2e.ts',
  ],
}

const fullStackProject = {
  ...projectCommon,
  displayName: `full-stack:${stack}`,
  testMatch: [scenarioForStack[stack]],
}

module.exports = {
  rootDir: __dirname,
  globalSetup: '<rootDir>/src/global-setup.ts',
  globalTeardown: '<rootDir>/src/global-teardown.ts',
  /* One shared database and one shared event stream: scenarios must not race each other. */
  maxWorkers: 1,
  verbose: true,
  /* Fast scenarios are quick; the full loop is ~6s vendor auto-complete + up to 10s poll + boot
   * slack. Individual full-stack tests set tighter per-test timeouts where they wait on the engine.
   * The antech and zoetis loops are the slow ones — see slowPollStacks above. */
  testTimeout: fullStack ? (slowPollStacks.includes(stack) ? 240_000 : 120_000) : 60_000,
  projects: [fullStack ? fullStackProject : fastProject],
}

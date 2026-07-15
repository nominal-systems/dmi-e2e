/* Two jest projects, mutually exclusive because they run dmi-api under different NODE_ENVs (seed vs
 * normal) and so cannot share one app process:
 *
 *   - fast (default):      smoke + tenant-isolation, dmi-api alone under NODE_ENV=seed.
 *   - full-stack:          the demo provider loop, dmi-api under a normal NODE_ENV against the real
 *                          engine/vendor stack. Selected by HARNESS_FULL_STACK=1.
 *
 * Only the selected project is included, so globalSetup/globalTeardown (which read env.fullStack to
 * bring up the right containers and app env) run exactly once per run. Global options (globalSetup,
 * globalTeardown, maxWorkers, testTimeout, verbose) live at the root — jest ignores them inside a
 * project config; only test-selection options are per-project. Scoped to scenarios/ so the helpers
 * in src/ are never picked up as test files. */
const fullStack =
  process.env.HARNESS_FULL_STACK === '1' ||
  (process.env.HARNESS_FULL_STACK ?? '').toLowerCase() === 'true'

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
  displayName: 'full-stack',
  testMatch: ['<rootDir>/scenarios/full-stack-*.e2e.ts'],
}

module.exports = {
  rootDir: __dirname,
  globalSetup: '<rootDir>/src/global-setup.ts',
  globalTeardown: '<rootDir>/src/global-teardown.ts',
  /* One shared database and one shared event stream: scenarios must not race each other. */
  maxWorkers: 1,
  verbose: true,
  /* Fast scenarios are quick; the full loop is ~6s vendor auto-complete + up to 10s poll + boot
   * slack. Individual full-stack tests set tighter per-test timeouts where they wait on the engine. */
  testTimeout: fullStack ? 120_000 : 60_000,
  projects: [fullStack ? fullStackProject : fastProject],
}

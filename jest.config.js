/* Two jest projects, mutually exclusive because they run dmi-api under different NODE_ENVs (seed vs
 * normal) and so cannot share one app process:
 *
 *   - fast (default):      smoke + tenant-isolation, dmi-api alone under NODE_ENV=seed.
 *   - full-stack:          a real provider loop, dmi-api under a normal NODE_ENV against the real
 *                          engine/vendor stack. Selected by HARNESS_FULL_STACK=1; HARNESS_STACK then
 *                          picks WHICH loop, by its key in the stack registry (src/stacks.js), which
 *                          is also where each loop's scenario file is named.
 *
 * Only the selected project is included, so globalSetup/globalTeardown (which read env.fullStack /
 * env.stack to bring up the right containers and app env) run exactly once per run. Global options
 * (globalSetup, globalTeardown, maxWorkers, testTimeout, verbose) live at the root — jest ignores
 * them inside a project config; only test-selection options are per-project. Scoped to scenarios/ so
 * the helpers in src/ are never picked up as test files.
 *
 * This file is loaded before ts-jest exists, so it cannot import src/env.ts. It reads the same
 * plain-JS registry env.ts does, and both resolve HARNESS_STACK through the registry's validator. */
const path = require('path')
const { resolveStack, stacks, suiteName } = require('./src/stacks')

const fullStack =
  process.env.HARNESS_FULL_STACK === '1' ||
  (process.env.HARNESS_FULL_STACK ?? '').toLowerCase() === 'true'
/* Throws on an unknown value. src/env.ts would refuse it anyway; refusing here too means a typo can
 * never silently select the default loop. */
const stack = resolveStack(process.env.HARNESS_STACK)

/* Run report: reports/<suite>/index.html (jest-html-reporters, one self-contained file) plus
 * summary.json (src/report/summary-reporter.js) for the run index src/report/report.ts builds.
 * The directory mirrors env.report.dir in src/env.ts. */
const suite = suiteName(fullStack, stack)
const reportDir = path.join(
  path.resolve(process.env.HARNESS_REPORT_DIR || path.join(__dirname, 'reports')),
  suite,
)

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
  testMatch: [`<rootDir>/${stacks[stack].scenario}`],
}

module.exports = {
  rootDir: __dirname,
  globalSetup: '<rootDir>/src/global-setup.ts',
  globalTeardown: '<rootDir>/src/global-teardown.ts',
  /* One shared database and one shared event stream: scenarios must not race each other. */
  maxWorkers: 1,
  verbose: true,
  reporters: [
    'default',
    ['jest-html-reporters', {
      publicPath: reportDir,
      filename: 'index.html',
      inlineSource: true,
      pageTitle: `dmi-e2e · ${suite}`,
      expand: true,
      hideIcon: true,
      openReport: false,
    }],
    ['<rootDir>/src/report/summary-reporter.js', { outputDir: reportDir }],
  ],
  /* Fast scenarios are quick; the full loop is ~6s vendor auto-complete + up to 10s poll + boot
   * slack. Individual full-stack tests set tighter per-test timeouts where they wait on the engine.
   * A loop whose integration hardcodes its poll interval (the registry's `slowPoll`) can leave a
   * result waiting a full tick, so its default budget absorbs a missed one. */
  testTimeout: fullStack ? (stacks[stack].slowPoll ? 240_000 : 120_000) : 60_000,
  projects: [fullStack ? fullStackProject : fastProject],
}

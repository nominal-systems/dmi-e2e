/* Scoped to scenarios/ so the helpers in src/ are never picked up as test files. */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: 'scenarios/.*\\.e2e\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  globalSetup: '<rootDir>/src/global-setup.ts',
  globalTeardown: '<rootDir>/src/global-teardown.ts',
  /* One shared database and one shared event stream: scenarios must not race each other. */
  maxWorkers: 1,
  testTimeout: 60_000,
  verbose: true,
}

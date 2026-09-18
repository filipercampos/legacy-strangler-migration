/** @type {import('jest').Config} */
const transform = { '^.+\.ts$': ['ts-jest', { isolatedModules: true }] };
const common = { testEnvironment: 'node', moduleFileExtensions: ['js', 'json', 'ts'], transform };

module.exports = {
  projects: [
    { ...common, displayName: 'unit', testMatch: ['<rootDir>/src/**/*.spec.ts'] },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
    },
  ],
  // Integration suites start SQL Server; unit tests are far below this.
  testTimeout: 180000,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/main.ts', '!src/**/*.module.ts'],
};

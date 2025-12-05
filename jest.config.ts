import type { Config } from 'jest';

const config: Config = {
    verbose: true,
    testEnvironment: 'node',
    testMatch: ['**/*.spec.ts'],
    preset: 'ts-jest',
    silent: false,
    coverageThreshold: {
        global: {
            statements: 77,
            branches: 70,
            functions: 78,
            lines: 78,
        },
    },
    coverageReporters: ['json-summary', 'text', 'lcov'],
};

export default config;

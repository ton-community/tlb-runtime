import type { Config } from 'jest';

const config: Config = {
    verbose: true,
    testEnvironment: 'node',
    testMatch: ['**/*.spec.ts'],
    preset: 'ts-jest',
    silent: false,
    coverageThreshold: {
        global: {
            statements: 55,
            branches: 48,
            functions: 72,
            lines: 56,
        },
    },
    coverageReporters: ['json-summary', 'text', 'lcov'],
};

export default config;

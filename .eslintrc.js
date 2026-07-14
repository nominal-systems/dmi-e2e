module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
    jest: true
  },
  extends: ['plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: './tsconfig.json'
  },
  plugins: ['@typescript-eslint'],
  ignorePatterns: ['.eslintrc.js', 'jest.config.js', 'node_modules', 'dist'],
  rules: {
    // The harness deliberately treats API responses as untyped JSON: asserting on a typed mirror
    // of dmi-api's DTOs would recreate the coupling this repo exists to avoid.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true
    }]
  }
}

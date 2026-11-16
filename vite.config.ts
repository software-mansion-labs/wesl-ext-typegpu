// vp migrate: merged .oxlintrc.json (70071b33518c2408813894b9bc30b90f).
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    printWidth: 80,
    singleQuote: true,
    sortImports: {},
    sortPackageJson: false,
    ignorePatterns: ['pnpm-lock.yaml'],
  },
  lint: {
    plugins: ['typescript', 'unicorn', 'oxc'],
    categories: {
      correctness: 'error',
    },
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    env: {
      builtin: true,
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
  },
});

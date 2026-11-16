import { type UserConfig, defineConfig } from 'vite-plus';

const config: UserConfig = defineConfig({
  pack: {
    entry: ['./src/index.ts'],
    // wesl and wesl-plugin are ESM-only, so there's no point in a CJS build
    format: 'esm',
    platform: 'node',
    dts: true,
    clean: true,
  },
});

export default config;

import { defineConfig, lazyPlugins } from 'vite-plus';
import { typegpuExtension } from 'wesl-ext-typegpu';
import { linkBuildExtension } from 'wesl-plugin';
import weslPlugin from 'wesl-plugin/vite';

export default defineConfig({
  plugins: lazyPlugins(() => [
    weslPlugin({ extensions: [linkBuildExtension, typegpuExtension] }),
  ]),
  build: {
    // Every browser that supports WebGPU also supports top-level await
    target: 'es2022',
  },
});

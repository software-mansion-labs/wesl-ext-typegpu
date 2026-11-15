import { defineConfig } from 'vite';
import { typegpuExtension } from 'wesl-ext-typegpu';
import { linkBuildExtension } from 'wesl-plugin';
import weslPlugin from 'wesl-plugin/vite';

export default defineConfig({
  plugins: [weslPlugin({ extensions: [linkBuildExtension, typegpuExtension] })],
});

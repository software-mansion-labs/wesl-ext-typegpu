import { defineConfig } from "vite";
import weslPlugin from "wesl-plugin/vite";
import { linkBuildExtension } from "wesl-plugin";
import { typegpuExtension } from "wesl-ext-typegpu";

export default defineConfig({
  plugins: [weslPlugin({ extensions: [linkBuildExtension, typegpuExtension] })],
});

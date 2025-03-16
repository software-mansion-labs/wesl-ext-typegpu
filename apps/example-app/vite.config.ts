import { defineConfig } from "vite";
import weslPlugin from "wesl-plugin/vite";
import { linkBuildExtension } from "wesl-plugin";

export default defineConfig({
  plugins: [weslPlugin({ extensions: [linkBuildExtension] })],
});

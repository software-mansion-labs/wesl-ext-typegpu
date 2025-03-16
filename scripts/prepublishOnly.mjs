// This project uses pnpm-specific functionality, like extensions to publishConfig in package.json.
if (!process.env.npm_config_user_agent.startsWith("pnpm")) {
  console.error(
    "This script must be executed by pnpm! Make sure to `pnpm run ...` instead of `npm run ...`",
  );
  process.exit(1);
}

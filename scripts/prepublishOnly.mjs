import { type } from "arktype";
import { readPackageJSON } from "pkg-types";

const PublishTag = type('"alpha" | "beta" | undefined');

const packageJSON = await readPackageJSON();
const chosenPublishTag = PublishTag.assert(process.env.npm_config_tag);

let tagVerified = false;
for (const { unit: tag } of PublishTag.json) {
  if (packageJSON.version.includes(tag)) {
    if (tag !== chosenPublishTag) {
      throw new Error(
        `Publishing under a mismatched tag "${chosenPublishTag}" for version ${packageJSON.version}. Use --tag ${tag}`,
      );
    }

    tagVerified = true;
    break;
  }
}

if (!tagVerified) {
  throw new Error(
    `Publishing under a mismatched tag "${chosenPublishTag}" for version ${packageJSON.version}.`,
  );
}

// This project uses pnpm-specific functionality, like extensions to publishConfig in package.json.
if (!process.env.npm_config_user_agent.startsWith("pnpm")) {
  console.error(
    "This script must be executed by pnpm! Make sure to `pnpm run ...` instead of `npm run ...`",
  );
  process.exit(1);
}

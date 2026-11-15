import { readFile } from 'node:fs/promises';

import { assertRunByPnpm, verifyPublishTag } from './publishTag.mjs';

try {
  assertRunByPnpm(process.env.npm_config_user_agent);

  // Lifecycle scripts run in the directory of the package being published.
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  verifyPublishTag(version, process.env.npm_config_tag);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

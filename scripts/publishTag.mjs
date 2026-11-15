/**
 * Prerelease labels that have to be published under a dist-tag of the same
 * name. A version without a prerelease label is published under the default
 * tag.
 */
export const PRERELEASE_TAGS = ['alpha', 'beta'];

/**
 * Throws unless the publish was started by pnpm 10 or older.
 *
 * This project uses pnpm-specific functionality, like extensions to
 * `publishConfig` in package.json. pnpm 11 and later no longer expose the
 * `--tag` flag to lifecycle scripts as `npm_config_tag`, so the tag check
 * below cannot work there.
 *
 * @param {string | undefined} userAgent value of `npm_config_user_agent`
 */
export function assertRunByPnpm(userAgent) {
  const match = /^pnpm\/(\d+)\./.exec(userAgent ?? '');
  if (!match) {
    throw new Error(
      'This script must be executed by pnpm! Make sure to `pnpm publish` instead of `npm publish`.',
    );
  }
  const major = Number(match[1]);
  if (major >= 11) {
    throw new Error(
      `pnpm ${major} does not pass the --tag flag to lifecycle scripts, so the publish tag cannot be verified. Publish with the pnpm version from "packageManager" in package.json.`,
    );
  }
}

/**
 * Returns the prerelease label of a semver version, or `undefined` for a
 * stable version. `0.1.0-alpha.2` → `alpha`, `1.0.0` → `undefined`.
 *
 * @param {string} version
 * @returns {string | undefined}
 */
export function prereleaseLabel(version) {
  const match =
    /^\d+\.\d+\.\d+(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version,
    );
  if (!match) {
    throw new Error(`"${version}" is not a valid semver version.`);
  }
  return match[1]?.split('.')[0];
}

/**
 * Throws unless `tag` is the right dist-tag for `version`. Prerelease versions
 * must be published under the tag matching their label, stable versions under
 * the default tag (`tag` unset, or `latest`).
 *
 * @param {string} version
 * @param {string | undefined} tag value of `npm_config_tag`
 */
export function verifyPublishTag(version, tag) {
  const label = prereleaseLabel(version);
  const chosen = tag === undefined || tag === '' ? 'latest' : tag;

  if (label === undefined) {
    if (chosen !== 'latest') {
      throw new Error(
        `Publishing stable version ${version} under the "${chosen}" tag. Publish without --tag.`,
      );
    }
    return;
  }

  if (!PRERELEASE_TAGS.includes(label)) {
    throw new Error(
      `Unknown prerelease label "${label}" in version ${version}. Expected one of: ${PRERELEASE_TAGS.join(', ')}.`,
    );
  }

  if (chosen !== label) {
    throw new Error(
      `Publishing version ${version} under a mismatched tag "${chosen}". Use --tag ${label}`,
    );
  }
}

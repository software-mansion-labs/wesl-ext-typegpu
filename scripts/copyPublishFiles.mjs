// Copies files that live in the repository root (README, LICENSE) into the
// package directory, so they end up in the published tarball. Run from the
// package directory, as a `prepack` script. Pass `--clean` to remove the copies.
import { copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['README.md', 'LICENSE.md'];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = process.cwd();
const clean = process.argv.includes('--clean');

for (const file of FILES) {
  const target = join(packageDir, file);
  if (clean) {
    await rm(target, { force: true });
  } else {
    await copyFile(join(repoRoot, file), target);
  }
}

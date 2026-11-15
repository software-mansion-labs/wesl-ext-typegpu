import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const packageDir = join(import.meta.dirname, '..');
const repoRoot = join(packageDir, '../..');
const packageJSON = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
);

describe('package metadata', () => {
  it('declares typegpu as a peer dependency, since emitted modules import typegpu/data', () => {
    expect(packageJSON.peerDependencies.typegpu).toBeDefined();
  });

  it('declares the Node version that supports Set methods and iterator helpers', () => {
    expect(packageJSON.engines.node).toBe('>=22.0.0');
  });

  it('is MIT licensed', () => {
    expect(packageJSON.license).toBe('MIT');
    expect(readFileSync(join(repoRoot, 'LICENSE.md'), 'utf8')).toMatch(
      /^MIT License/,
    );
  });
});

describe('pnpm pack', () => {
  const destination = mkdtempSync(join(tmpdir(), 'wesl-ext-typegpu-pack-'));
  afterAll(() => rmSync(destination, { recursive: true, force: true }));

  it(
    'ships the README and LICENSE from the repository root',
    { timeout: 30_000 },
    () => {
      const output = execFileSync(
        'pnpm',
        ['pack', '--json', '--pack-destination', destination],
        {
          cwd: packageDir,
          encoding: 'utf8',
        },
      );
      // Lifecycle script logs are printed before the JSON report.
      const report = JSON.parse(output.slice(output.indexOf('{\n')));
      const paths: string[] = report.files.map(
        (file: { path: string }) => file.path,
      );

      expect(paths).toContain('README.md');
      expect(paths).toContain('LICENSE.md');
      expect(paths).toContain('package.json');
      expect(paths).toContain('suffixes.d.ts');

      // The copies are cleaned up after packing.
      expect(existsSync(join(packageDir, 'README.md'))).toBe(false);
      expect(existsSync(join(packageDir, 'LICENSE.md'))).toBe(false);
    },
  );
});

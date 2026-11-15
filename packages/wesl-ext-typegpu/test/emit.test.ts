import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { RecordResolver } from 'wesl';
import type { PluginExtensionApi } from 'wesl-plugin';

import { typegpuExtension } from '../src/index.ts';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

/** Loads every .wesl file under `dir`, keyed by its path relative to `dir` (like wesl-plugin does). */
async function loadWeslSources(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true });
  const weslFiles = entries.filter((e) => e.endsWith('.wesl')).sort();
  const sources = await Promise.all(
    weslFiles.map(async (file) => {
      const src = await readFile(join(dir, file), 'utf-8');
      return [file.replaceAll('\\', '/'), src.replace(/\r\n/g, '\n')] as const;
    }),
  );
  return Object.fromEntries(sources);
}

/**
 * Runs the extension the same way wesl-plugin would for `import ... from '<weslRoot>/<modulePath>?typegpu'`,
 * but against an in-memory set of sources instead of a bundler context.
 */
async function emit(
  weslSrc: Record<string, string>,
  modulePath: string,
): Promise<string> {
  const registry = new RecordResolver(weslSrc);
  const api = {
    weslMain: async () => modulePath,
    weslRegistry: async () => registry,
  } as Partial<PluginExtensionApi> as PluginExtensionApi;

  return typegpuExtension.emitFn(modulePath, api);
}

describe('fixtures', async () => {
  const weslSrc = await loadWeslSources(fixturesDir);

  it.for(Object.keys(weslSrc))('%s', async (modulePath) => {
    expect(await emit(weslSrc, modulePath)).toMatchSnapshot();
  });
});

describe('inline sources', () => {
  it('emits nothing but the typegpu/data import for a module without structs', async () => {
    const result = await emit(
      { 'main.wesl': 'fn main() -> f32 { return 1.0; }' },
      'main.wesl',
    );
    expect(result).toMatchInlineSnapshot(`"import * as d from 'typegpu/data'"`);
  });

  it('throws when the module cannot be resolved', async () => {
    await expect(emit({}, 'missing.wesl')).rejects.toThrow(
      /Unable to resolve WESL module/,
    );
  });
});

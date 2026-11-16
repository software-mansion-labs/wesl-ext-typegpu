import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vite-plus/test';

function typecheck(projectDir: string): string[] {
  const configPath = join(projectDir, 'tsconfig.json');
  const { config } = ts.readConfigFile(configPath, (path) =>
    ts.sys.readFile(path),
  );
  const { fileNames, options } = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    projectDir,
    undefined,
    configPath,
  );
  const program = ts.createProgram(fileNames, options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
}

describe('suffixes.d.ts', () => {
  it(
    'types ?typegpu imports, with conditions before typegpu',
    { timeout: 30_000 },
    () => {
      expect(typecheck(join(import.meta.dirname, 'fixtures/suffixes'))).toEqual(
        [],
      );
    },
  );
});

import {
  type ImportElem,
  type ImportStatement,
  declsOfKind,
  fileToModulePath,
} from 'wesl';
import type { PluginExtensionApi } from 'wesl-plugin';

import { generateImportSnippets } from './imports.ts';
import { generateStructSnippets } from './structs.ts';

export const typegpuExtension: {
  extensionName: 'typegpu';
  emitFn: typeof emitReflectJs;
} = {
  extensionName: 'typegpu',
  emitFn: emitReflectJs,
};

async function emitReflectJs(
  baseId: string,
  api: PluginExtensionApi,
): Promise<string> {
  const rootModule = await api.weslMain(baseId);
  const moduleName = fileToModulePath(rootModule, 'package', false);

  const registry = await api.weslRegistry();
  const ast = registry.resolveModule(moduleName);
  if (!ast) {
    throw new Error(`Unable to resolve WESL module '${moduleName}'!`);
  }

  const imports = declsOfKind(ast.moduleElem, 'import');
  const structs = declsOfKind(ast.moduleElem, 'struct');
  const aliases = declsOfKind(ast.moduleElem, 'alias');
  const typeDecls = [...structs, ...aliases];

  const importsNamespace = findOccupiedIdentifiers(imports);

  const importSnippets = generateImportSnippets(
    typeDecls,
    imports,
    importsNamespace,
  );
  const structSnippets = generateStructSnippets(typeDecls, importsNamespace);

  const src = [...importSnippets, ...structSnippets].join('\n');

  return src;
}

function findOccupiedIdentifiers(importElems: ImportElem[]) {
  const imports = new Set<string>();

  function traverseImport(importElem: ImportStatement) {
    const segment = importElem.finalSegment;
    if (segment.kind === 'import-item') {
      imports.add(segment.as ?? segment.name);
    } else {
      for (const subImport of segment.subtrees) {
        traverseImport(subImport);
      }
    }
  }

  for (const elem of importElems) {
    traverseImport(elem.imports);
  }
  return imports;
}

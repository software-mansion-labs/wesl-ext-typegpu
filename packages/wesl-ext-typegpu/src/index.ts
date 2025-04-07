import { type ImportElem, type ImportStatement, noSuffix } from 'wesl';
import type { PluginExtensionApi } from 'wesl-plugin';
import { generateImportSnippets } from './imports.ts';
import { generateStructSnippets } from './structs.ts';

export const typegpuExtension = {
  extensionName: 'typegpu',
  emitFn: emitReflectJs,
};

async function emitReflectJs(baseId: string, api: PluginExtensionApi) {
  const rootModule = await api.weslMain(baseId);
  const rootModuleName = noSuffix(rootModule);
  const moduleName = `./${rootModuleName}`
    .replaceAll('/', '::')
    .replace('.', 'package');

  const registry = await api.weslRegistry();

  const abstractElements = registry.modules[moduleName].moduleElem.contents;

  const imports = abstractElements.filter((e) => e.kind === 'import');
  const structs = abstractElements.filter((e) => e.kind === 'struct');

  const importsNamespace = findOccupiedIdentifiers(imports);

  const importSnippets = generateImportSnippets(
    structs,
    imports,
    importsNamespace,
  );
  const structSnippets = generateStructSnippets(structs, importsNamespace);

  const src = [...importSnippets, ...structSnippets].join('\n');

  console.log(src);

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

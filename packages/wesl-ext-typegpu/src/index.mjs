// @ts-check

import { noSuffix } from 'wesl';
import { generateStructSnippets } from './structs.mjs';
import { generateImportSnippets } from './imports.mjs';

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").StructElem} StructElem */
/** @typedef {import("wesl").ImportElem} ImportElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */
/** @typedef {import("wesl").TypeRefElem} TypeRefElem */

/** @type {import("wesl-plugin").PluginExtension} */
export const typegpuExtension = {
  extensionName: 'typegpu',
  emitFn: emitReflectJs,
};

/**
 * @param {string} baseId
 * @param {import("wesl-plugin").PluginExtensionApi} api
 * @returns {Promise<string>}
 */
async function emitReflectJs(baseId, api) {
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

/**
 * This function finds all identifiers that are occupied by import statements.
 * Identifiers occupied by other statements (var, struct etc.) are not included.
 * @param {ImportElem[]} importElems
 */
function findOccupiedIdentifiers(importElems) {
  /** @type {Set<string>} */
  const imports = new Set();

  /**
   * @param {ImportStatement} importElem
   */
  function traverseImport(importElem) {
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

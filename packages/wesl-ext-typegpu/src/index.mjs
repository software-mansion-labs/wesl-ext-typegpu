// @ts-check

import path from 'node:path';
import { genImport } from 'knitwork';
import { noSuffix } from 'wesl';
import { generateStruct, sortStructs } from './structs.mjs';
import { parseImports } from './imports.mjs';

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */

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

  const registry = await api.weslRegistry();

  /** @type {string[]} */
  const snippets = [genImport('typegpu/data', '* as d')];

  const rootName = path.basename(rootModuleName);

  const abstractElements =
    registry.modules[`package::${rootName}`].moduleElem.contents;

  const imports = parseImports(abstractElements);

  const sortedStructs = sortStructs(
    abstractElements.filter((element) => element.kind === 'struct'),
  );
  const nonTgpuIdentifiers = new Set(
    sortedStructs.map((struct) => struct.name.ident.originalName),
  ).union(findAllImports(abstractElements));

  for (const elem of sortedStructs) {
    snippets.push(generateStruct(elem, nonTgpuIdentifiers));
  }

  const src = `${imports.join('\n')}\n${snippets.join('\n')}`;

  console.log(src);

  return src;
}

/**
 * @param {AbstractElem[]} elements
 */
function findAllImports(elements) {
  /** @type {Set<string>} */
  const imports = new Set();
  for (const elem of elements) {
    if (elem.kind === 'import') {
      traverseImport(elem.imports, imports);
    }
  }
  return imports;
}

/**
 * @param {ImportStatement} importElem
 * @param {Set<string>} importsSet
 */
function traverseImport(importElem, importsSet) {
  const segment = importElem.finalSegment;
  if (segment.kind === 'import-item') {
    importsSet.add(segment.name);
  } else {
    for (const subImport of segment.subtrees) {
      traverseImport(subImport, importsSet);
    }
  }
}

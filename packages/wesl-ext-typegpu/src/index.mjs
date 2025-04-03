// @ts-check

import { genImport } from 'knitwork';
import { noSuffix } from 'wesl';
import { generateStruct, sortStructs } from './structs.mjs';
import { parseImports } from './imports.mjs';

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

  const structElems = abstractElements.filter((e) => e.kind === 'struct');
  const importElems = abstractElements.filter((e) => e.kind === 'import');

  const importSnippets = generateImportSnippets(structElems, importElems);
  const structSnippets = generateStructSnippets(structElems, importElems);

  const src = [...importSnippets, ...structSnippets].join('\n');

  console.log(src);

  return src;
}

/**
 * @param {StructElem[]} structElems
 * @param {ImportElem[]} importElems
 */
function generateImportSnippets(structElems, importElems) {
  const identifiersToImport = findIdentifiersToImport(structElems, importElems);
  const inlinedImports = findInlinedImports(structElems);

  const imports = [
    `import * as d from 'typegpu/data'`,
    ...parseImports(importElems, identifiersToImport, inlinedImports),
  ];
  return imports;
}

/**
 * @param {StructElem[]} structElems
 * @param {ImportElem[]} importElems
 */
function generateStructSnippets(structElems, importElems) {
  const sortedStructs = sortStructs(structElems);

  const nonTgpuIdentifiers = new Set(
    sortedStructs.map((struct) => struct.name.ident.originalName),
  ).union(findAllImports(importElems));

  return sortedStructs.map((elem) => generateStruct(elem, nonTgpuIdentifiers));
}

/**
 * Finds items and modules that are imported in the source,
 * then narrows those to identifiers that are used in struct declarations
 * @param {StructElem[]} structElems
 * @param {ImportElem[]} importElems
 */
function findIdentifiersToImport(structElems, importElems) {
  const allImports = findAllImports(importElems);
  const usedImports = findUsedImports(structElems, allImports);
  return usedImports;
}

/**
 * @param {ImportElem[]} importElems
 */
function findAllImports(importElems) {
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

/**
 * @param {StructElem[]} structElements
 * @param {Set<string>} allImports
 */
function findUsedImports(structElements, allImports) {
  /** @type {Set<string>} */
  const usedImports = new Set();

  /**
   * @param {TypeRefElem} typeRef
   */
  function findUsedImportsInType(typeRef) {
    if (allImports.has(typeRef.name.originalName)) {
      usedImports.add(typeRef.name.originalName);
    }
    for (const subtype of typeRef.templateParams ?? []) {
      if (subtype.kind === 'type') {
        findUsedImportsInType(subtype);
      }
    }
  }

  for (const struct of structElements) {
    for (const member of struct.members) {
      findUsedImportsInType(member.typeRef);
    }
  }

  return usedImports;
}

/**
 * @param {StructElem[]} structElements
 */
function findInlinedImports(structElements) {
  /** @type {Set<string>} */
  const importsInStructs = new Set();

  /**
   * @param {TypeRefElem} typeRef
   */
  function findUsedImportsInType(typeRef) {
    if (typeRef.name.originalName.includes('::')) {
      importsInStructs.add(typeRef.name.originalName);
    }
    for (const subtype of typeRef.templateParams ?? []) {
      if (subtype.kind === 'type') {
        findUsedImportsInType(subtype);
      }
    }
  }

  for (const struct of structElements) {
    for (const member of struct.members) {
      findUsedImportsInType(member.typeRef);
    }
  }

  return importsInStructs;
}

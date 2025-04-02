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

  /** @type {string[]} */
  const snippets = [genImport('typegpu/data', '* as d')];

  const structElems = abstractElements.filter(
    (element) => element.kind === 'struct',
  );
  const importElems = abstractElements.filter(
    (element) => element.kind === 'import',
  );

  const identifiersToImport = findIdentifiersToImport(structElems, importElems);
  const inlinedImports = findInlinedImports(structElems);

  const imports = parseImports(
    importElems,
    identifiersToImport,
    inlinedImports,
  );

  const sortedStructs = sortStructs(structElems);

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
 * @param {AbstractElem[]} elements
 */
function findAllImports(elements) {
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

  for (const elem of elements) {
    if (elem.kind === 'import') {
      traverseImport(elem.imports);
    }
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

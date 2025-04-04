// @ts-check

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

  const importElems = abstractElements.filter((e) => e.kind === 'import');
  const structElems = abstractElements.filter((e) => e.kind === 'struct');

  // identifiers that are occupied by imports
  const importsNamespace = findAllImports(importElems);

  const importSnippets = generateImportSnippets(
    structElems,
    importElems,
    importsNamespace,
  );
  const structSnippets = generateStructSnippets(
    structElems,
    importElems,
    importsNamespace,
  );

  const src = [...importSnippets, ...structSnippets].join('\n');

  console.log(src);

  return src;
}

/**
 * @param {StructElem[]} structElems
 * @param {ImportElem[]} importElems
 * @param {Set<string>} importsNamespace
 */
function generateImportSnippets(structElems, importElems, importsNamespace) {
  const { inlinedImports, directImports } = findImportsUsedInStructs(
    structElems,
    importsNamespace,
  );

  const imports = [
    `import * as d from 'typegpu/data'`,
    ...parseImports(importElems, directImports, inlinedImports),
  ];
  return imports;
}

/**
 * @param {StructElem[]} structElems
 * @param {ImportElem[]} importElems
 * @param {Set<string>} importsNamespace
 */
function generateStructSnippets(structElems, importElems, importsNamespace) {
  const sortedStructs = sortStructs(structElems);

  // We need to know which identifiers are in typegpu/std and need to be prepended with 'd.'.
  // Our approach is to find all type identifiers in the namespace introduced by imports and defined structs
  // and to prepend everything else (that is not an inlined import) with 'd.'.
  const nonTgpuIdentifiers = new Set(
    sortedStructs.map((struct) => struct.name.ident.originalName),
  ).union(importsNamespace);

  return sortedStructs.map((elem) => generateStruct(elem, nonTgpuIdentifiers));
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
 * @param {Set<string>} importsNamespace
 */
function findImportsUsedInStructs(structElements, importsNamespace) {
  /** @type {Set<string>} */
  const inlinedImports = new Set();
  /** @type {Set<string>} */
  const directImports = new Set();

  /**
   * @param {TypeRefElem} typeRef
   */
  function findUsedImportsInType(typeRef) {
    const name = typeRef.name.originalName;
    if (name.includes('::')) {
      inlinedImports.add(name);
    }
    if (importsNamespace.has(name)) {
      directImports.add(name);
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

  return { inlinedImports, directImports };
}

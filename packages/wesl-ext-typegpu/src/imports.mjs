// @ts-check

import { assertDefined } from './utils.mjs';

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").StructElem} StructElem */
/** @typedef {import("wesl").ImportElem} ImportElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */
/** @typedef {import("wesl").TypeRefElem} TypeRefElem */
/** @typedef {{ path: string, finalSegment: string }} ImportInfo */

/**
 * @param {StructElem[]} structElems
 * @param {ImportElem[]} importElems
 * @param {Set<string>} importsNamespace
 */
export function generateImportSnippets(
  structElems,
  importElems,
  importsNamespace,
) {
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
 * @param {ImportElem[]} importElems
 * @param {Set<string>} identifiersToImport
 * @param {Set<string>} inlinedImports
 */
function parseImports(importElems, identifiersToImport, inlinedImports) {
  /** @type {Map<string, ImportInfo>} */
  const importOfAlias = generateImportMap(importElems);

  /** @type {string[]} */
  const resultImports = [];

  for (const identifier of identifiersToImport) {
    const importInfo = assertDefined(importOfAlias.get(identifier));
    resultImports.push(
      generateImport(importInfo.path, importInfo.finalSegment, identifier),
    );
  }

  for (const inlinedImport of inlinedImports) {
    const splitImport = inlinedImport.split('::');
    const importInfo = importOfAlias.get(splitImport[0]);
    let path;
    const item = assertDefined(splitImport.at(-1));
    const alias = splitImport.join('$');
    if (importInfo) {
      // the import extends an existing import
      path = [
        importInfo.path,
        importInfo.finalSegment,
        ...splitImport.slice(1, -1),
      ].join('/');
    } else {
      // the import falls through
      path = splitImport
        .slice(0, -1)
        .join('/')
        .replaceAll('package', '.')
        .replaceAll('super', '..');
    }
    resultImports.push(generateImport(path, item, alias));
  }

  return resultImports;
}

/**
 * @param {ImportElem[]} importElems
 * @returns {Map<string, ImportInfo>}
 * e.g. for "import package::folder::file as NestedAlias;" we get entry
 * "NestedAlias" => { path: "./folder", finalSegment: "file" }
 */
function generateImportMap(importElems) {
  /** @type {Map<string, ImportInfo>} */
  const importOfAlias = new Map();

  /**
   * @param {ImportStatement} importElem
   * @param {string} currentPath
   */
  function traverseImport(importElem, currentPath) {
    const newPath =
      currentPath +
      importElem.segments
        .map((elem) =>
          elem.name === 'package'
            ? '.'
            : elem.name === 'super'
              ? '..'
              : elem.name,
        )
        .join('/');

    const segment = importElem.finalSegment;
    if (segment.kind === 'import-item') {
      const alias = segment.as ?? segment.name;
      importOfAlias.set(alias, { path: newPath, finalSegment: segment.name });
    } else {
      for (const subImport of segment.subtrees) {
        traverseImport(subImport, newPath);
      }
    }
  }

  for (const elem of importElems) {
    traverseImport(elem.imports, '');
  }

  return importOfAlias;
}

/**
 * @param {string} path
 * @param {string} item
 * @param {string} [alias]
 */
function generateImport(path, item, alias) {
  return `import { ${item}${alias ? ` as ${alias}` : ''} } from '${path}.wesl?typegpu';`;
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

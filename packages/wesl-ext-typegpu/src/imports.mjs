// @ts-check

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").ImportElem} ImportElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */
/** @typedef {{ path: string, finalSegment: string }} ImportInfo */

/**
 * @param {ImportElem[]} importElems
 * @param {Set<string>} identifiersToImport
 * @param {Set<string>} inlinedImports
 */
export function parseImports(importElems, identifiersToImport, inlinedImports) {
  /** @type {Map<string, ImportInfo>} */
  const importOfAlias = generateImportMap(importElems);

  /** @type {string[]} */
  const resultImports = [];

  for (const identifier of identifiersToImport) {
    const importInfo = importOfAlias.get(identifier);
    if (!importInfo) {
      throw new Error('This should never happen.');
    }
    if (importInfo?.finalSegment === identifier) {
      resultImports.push(generateImport(importInfo.path, identifier));
    } else {
      resultImports.push(
        generateImport(importInfo.path, importInfo.finalSegment, identifier),
      );
    }
  }

  for (const inlinedImport of inlinedImports) {
    const splitImport = inlinedImport.split('::');
    const importInfo = importOfAlias.get(splitImport[0]);
    if (importInfo) {
      // continue the import
      const jsified = `${importInfo.path}/${splitImport.slice(0, -1).join('/')}`;
      const aliasified = splitImport.join('$');

      resultImports.push(
        generateImport(
          jsified,
          /** @type {string} */ (splitImport.at(-1)),
          aliasified,
        ),
      );
    } else {
      const jsified = splitImport
        .slice(0, -1)
        .join('/')
        .replaceAll('package', '.')
        .replaceAll('super', '..');
      const aliasified = splitImport.join('$');

      resultImports.push(
        generateImport(
          jsified,
          /** @type {string} */ (splitImport.at(-1)),
          aliasified,
        ),
      );
    }
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

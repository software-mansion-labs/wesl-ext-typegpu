// @ts-check

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").ImportElem} ImportElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */

/**
 * @param {ImportElem[]} importElems
 * @param {Set<string>} identifiersToImport
 */
export function parseImports(importElems, identifiersToImport) {
  /** @type {string[]} */
  const resultImports = [];

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

    if (importElem.finalSegment.kind === 'import-item') {
      const name = importElem.finalSegment.name;
      if (identifiersToImport.has(name)) {
        resultImports.push(
          `import { ${importElem.finalSegment.name} } from '${newPath}.wesl?typegpu'`,
        );
      }
    } else {
      for (const subImport of importElem.finalSegment.subtrees) {
        traverseImport(subImport, newPath);
      }
    }
  }

  for (const elem of importElems) {
    traverseImport(elem.imports, '');
  }
  return resultImports;
}

// @ts-check

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */

/**
 * @param {AbstractElem[]} elements
 */
export function parseImports(elements) {
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
      resultImports.push(
        `import { ${importElem.finalSegment.name} } from '${newPath}.wesl?typegpu'`,
      );
    } else {
      for (const subImport of importElem.finalSegment.subtrees) {
        traverseImport(subImport, newPath);
      }
    }
  }

  for (const elem of elements) {
    if (elem.kind === 'import') {
      traverseImport(elem.imports, '');
    }
  }
  return resultImports;
}

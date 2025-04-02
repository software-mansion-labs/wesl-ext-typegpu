// @ts-check

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").ImportElem} ImportElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */

/**
 * @param {ImportElem[]} importElems
 * @param {Set<string>} identifiersToImport
 * @param {Set<string>} inlinedImports
 */
export function parseImports(importElems, identifiersToImport, inlinedImports) {
  /** @type {Map<string, { path: string, finalSegment: string }>} */
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

  /** @type {string[]} */
  const resultImports = [];

  for (const identifier of identifiersToImport) {
    const importInfo = importOfAlias.get(identifier);
    if (!importInfo) {
      throw new Error('This should never happen.');
    }
    if (importInfo?.finalSegment === identifier) {
      resultImports.push(
        `import { ${identifier} } from '${importInfo.path}.wesl?typegpu'`,
      );
    } else {
      resultImports.push(
        `import { ${importInfo.finalSegment} as ${identifier} } from '${importInfo.path}.wesl?typegpu'`,
      );
    }
  }

  for (const inlinedImport of inlinedImports) {
    const splitImport = inlinedImport.split('::');
    const importInfo = importOfAlias.get(splitImport[0]);
    if (importInfo) {
      // continue the import
      const jsified = splitImport.slice(0, -1).join('/');
      const aliasified = splitImport.join('$');

      resultImports.push(
        `import { ${splitImport.at(-1)} as ${aliasified} } from '${jsified}.wesl?typegpu'`,
      );
    } else {
      const jsified = splitImport
        .slice(0, -1)
        .join('/')
        .replaceAll('package', '.')
        .replaceAll('super', '..');
      const aliasified = splitImport.join('$');

      resultImports.push(
        `import { ${splitImport.at(-1)} as ${aliasified} } from '${jsified}.wesl?typegpu'`,
      );
    }
  }

  return resultImports;
}

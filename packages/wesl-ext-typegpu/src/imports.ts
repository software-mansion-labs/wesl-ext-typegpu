import type {
  ImportElem,
  ImportStatement,
  StructElem,
  TypeRefElem,
} from 'wesl';
import { assertDefined } from './utils.ts';

interface ImportInfo {
  path: string;
  finalSegment: string;
}
export function generateImportSnippets(
  structElems: StructElem[],
  importElems: ImportElem[],
  importsNamespace: Set<string>,
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
 * Returns two sets of strings.
 * `directImports` contains identifiers of imported items, e.g. `struct1`.
 * `inlinedImports` contains names of inlined imports, e.g. `package::file::struct2`
 */
function findImportsUsedInStructs(
  structElements: StructElem[],
  importsNamespace: Set<string>,
) {
  const directImports = new Set<string>();
  const inlinedImports = new Set<string>();

  function findImportsUsedInType(typeRef: TypeRefElem) {
    const name = typeRef.name.originalName;
    if (name.includes('::')) {
      inlinedImports.add(name);
    }
    if (importsNamespace.has(name)) {
      directImports.add(name);
    }
    for (const subtype of typeRef.templateParams ?? []) {
      if (subtype.kind === 'type') {
        findImportsUsedInType(subtype);
      }
    }
  }

  for (const struct of structElements) {
    for (const member of struct.members) {
      findImportsUsedInType(member.typeRef);
    }
  }

  return { inlinedImports, directImports };
}

function parseImports(
  importElems: ImportElem[],
  directImports: Set<string>,
  inlinedImports: Set<string>,
) {
  const importOfAlias = generateImportMap(importElems);
  const resultImports: string[] = [];

  for (const identifier of directImports) {
    const importInfo = assertDefined(importOfAlias.get(identifier));
    resultImports.push(
      generateImport(importInfo.path, importInfo.finalSegment, identifier),
    );
  }

  for (const inlinedImport of inlinedImports) {
    const splitInlined = inlinedImport.split('::');
    const importInfo = importOfAlias.get(splitInlined[0]);
    const path = importInfo
      ? // the import extends an existing import
        // e.g. 'module::item' where 'module' is imported
        [
          importInfo.path,
          importInfo.finalSegment,
          ...splitInlined.slice(1, -1),
        ].join('/')
      : // the import falls through
        // e.g. 'package::item'
        splitInlined
          .slice(0, -1)
          .join('/')
          .replaceAll('package', '.')
          .replaceAll('super', '..');

    resultImports.push(
      generateImport(
        path,
        assertDefined(splitInlined.at(-1)),
        splitInlined.join('$'),
      ),
    );
  }

  return resultImports;
}

/**
 * Returns an import map.
 * For example, for "import package::folder::file as NestedAlias;" we get entry
 * `"NestedAlias" => { path: "./folder", finalSegment: "file" }`
 */
function generateImportMap(importElems: ImportElem[]) {
  const importOfAlias = new Map<string, ImportInfo>();

  function traverseImport(importElem: ImportStatement, currentPath: string) {
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

function generateImport(path: string, item: string, alias: string | undefined) {
  return `import { ${item}${alias ? ` as ${alias}` : ''} } from '${path}.wesl?typegpu';`;
}

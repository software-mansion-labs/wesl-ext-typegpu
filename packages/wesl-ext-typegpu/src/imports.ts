import type {
  ImportElem,
  ImportStatement,
  StructElem,
  TypeRefElem,
} from 'wesl';

import { asTypeRef } from './types.ts';
import { assertDefined } from './utils.ts';

/**
 * Where an import alias points to, as a WESL path split into segments.
 * `local` paths are relative to the WESL root (`package::`/`super::` already resolved),
 * `library` paths are kept verbatim, starting with the library name.
 */
interface ResolvedPath {
  kind: 'local' | 'library';
  segments: string[];
}

/**
 * @param modulePath path of the module being emitted, e.g. `package::folder::main`
 */
export function generateImportSnippets(
  structElems: StructElem[],
  importElems: ImportElem[],
  importsNamespace: Set<string>,
  modulePath: string,
): string[] {
  const { inlinedImports, directImports } = findImportsUsedInStructs(
    structElems,
    importsNamespace,
  );

  const moduleSegments = modulePath.split('::').slice(1);
  const imports = [
    `import * as d from 'typegpu/data'`,
    ...parseImports(importElems, directImports, inlinedImports, moduleSegments),
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
): { inlinedImports: Set<string>; directImports: Set<string> } {
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
    for (const param of typeRef.templateParams ?? []) {
      const subtype = asTypeRef(param);
      if (subtype) {
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
  moduleSegments: string[],
): string[] {
  const importOfAlias = generateImportMap(importElems, moduleSegments);
  const resultImports: string[] = [];

  for (const identifier of directImports) {
    const resolved = assertDefined(importOfAlias.get(identifier));
    resultImports.push(
      generateImport(
        toSpecifier(resolved, moduleSegments),
        assertDefined(resolved.segments.at(-1)),
        identifier,
      ),
    );
  }

  for (const inlinedImport of inlinedImports) {
    const splitInlined = inlinedImport.split('::');
    const [first, ...rest] = splitInlined;
    const aliased = importOfAlias.get(assertDefined(first));
    const resolved: ResolvedPath = aliased
      ? // the path extends an existing import
        // e.g. 'module::item' where 'module' is imported
        { kind: aliased.kind, segments: [...aliased.segments, ...rest] }
      : // the path is self-contained, e.g. 'package::item'
        resolvePath(splitInlined, moduleSegments);

    resultImports.push(
      generateImport(
        toSpecifier(resolved, moduleSegments),
        assertDefined(splitInlined.at(-1)),
        splitInlined.join('$'),
      ),
    );
  }

  return resultImports;
}

/**
 * Resolves a WESL path (e.g. `super::structs::StructA`) against the module it appears in.
 * `package` is the WESL root. The first `super` is the directory of the current module,
 * and every further `super` goes one directory up, matching the WESL linker.
 */
function resolvePath(
  segments: string[],
  moduleSegments: string[],
): ResolvedPath {
  const [first, ...rest] = segments;
  if (first === 'package') {
    return { kind: 'local', segments: rest };
  }
  if (first === 'super') {
    let base = moduleSegments;
    let remaining = segments;
    while (remaining[0] === 'super') {
      if (base.length === 0) {
        throw new Error(
          `Import '${segments.join('::')}' in module 'package::${moduleSegments.join('::')}' goes above the WESL root`,
        );
      }
      base = base.slice(0, -1);
      remaining = remaining.slice(1);
    }
    return { kind: 'local', segments: [...base, ...remaining] };
  }
  return { kind: 'library', segments };
}

/**
 * Turns the path of an imported item into a specifier for the module that holds it,
 * relative to the directory of the module being emitted.
 */
function toSpecifier(resolved: ResolvedPath, moduleSegments: string[]) {
  const targetModule = resolved.segments.slice(0, -1);
  if (resolved.kind === 'library') {
    return targetModule.join('/');
  }

  const currentDir = moduleSegments.slice(0, -1);
  let common = 0;
  while (
    common < currentDir.length &&
    common < targetModule.length - 1 &&
    currentDir[common] === targetModule[common]
  ) {
    common++;
  }
  const ups = currentDir.length - common;
  return [
    ...(ups === 0 ? ['.'] : Array<string>(ups).fill('..')),
    ...targetModule.slice(common),
  ].join('/');
}

/**
 * Returns an import map from each imported identifier to the full path it refers to.
 * For example, for "import package::folder::file as NestedAlias;" we get entry
 * `"NestedAlias" => { kind: 'local', segments: ['folder', 'file'] }`
 */
function generateImportMap(
  importElems: ImportElem[],
  moduleSegments: string[],
): Map<string, ResolvedPath> {
  const importOfAlias = new Map<string, ResolvedPath>();

  function traverseImport(importElem: ImportStatement, prefix: string[]) {
    const path = [...prefix, ...importElem.segments.map((elem) => elem.name)];

    const segment = importElem.finalSegment;
    if (segment.kind === 'import-item') {
      const alias = segment.as ?? segment.name;
      importOfAlias.set(
        alias,
        resolvePath([...path, segment.name], moduleSegments),
      );
    } else {
      for (const subImport of segment.subtrees) {
        traverseImport(subImport, path);
      }
    }
  }

  for (const elem of importElems) {
    traverseImport(elem.imports, []);
  }

  return importOfAlias;
}

function generateImport(
  path: string,
  item: string,
  alias: string | undefined,
): string {
  return `import { ${item}${alias ? ` as ${alias}` : ''} } from '${path}.wesl?typegpu';`;
}

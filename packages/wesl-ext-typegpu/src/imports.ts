import type {
  AttributeElem,
  ImportElem,
  ImportStatement,
  TypeRefElem,
} from 'wesl';

import { forEachReferencedIdentifier } from './expressions.ts';
import type { TypeDeclElem } from './structs.ts';
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

interface ImportedItem {
  /** Specifier of the imported module, without the `.wesl?typegpu` suffix */
  path: string;
  /** Name of the item exported by the module */
  item: string;
  /** Local identifier the item is bound to */
  alias: string;
}

/**
 * @param modulePath path of the module being emitted, e.g. `package::folder::main`
 */
export function generateImportSnippets(
  declElems: TypeDeclElem[],
  importElems: ImportElem[],
  importsNamespace: Set<string>,
  modulePath: string,
  constReferences: Iterable<string> = [],
): string[] {
  const { inlinedImports, directImports } = findImportsUsedInStructs(
    declElems,
    importsNamespace,
    constReferences,
  );

  const moduleSegments = modulePath.split('::').slice(1);
  return [
    `import * as d from 'typegpu/data';`,
    ...generateImports(
      parseImports(importElems, directImports, inlinedImports, moduleSegments),
    ),
  ];
}

/**
 * Finds imports used by the declarations and by the identifiers referenced by emitted consts.
 * Returns two sets of strings.
 * `directImports` contains identifiers of imported items, e.g. `struct1`.
 * `inlinedImports` contains names of inlined imports, e.g. `package::file::struct2`
 */
function findImportsUsedInStructs(
  declElements: TypeDeclElem[],
  importsNamespace: Set<string>,
  constReferences: Iterable<string>,
): { inlinedImports: Set<string>; directImports: Set<string> } {
  const directImports = new Set<string>();
  const inlinedImports = new Set<string>();

  function addName(name: string) {
    if (name.includes('::')) {
      inlinedImports.add(name);
    }
    if (importsNamespace.has(name)) {
      directImports.add(name);
    }
  }

  function findImportsUsedInType(typeRef: TypeRefElem) {
    addName(typeRef.name.originalName);
    for (const param of typeRef.templateParams ?? []) {
      const subtype = asTypeRef(param);
      if (subtype) {
        findImportsUsedInType(subtype);
      } else {
        // e.g. the length of an array
        forEachReferencedIdentifier(param, addName);
      }
    }
  }

  function findImportsUsedInAttributes(attributes: AttributeElem[] = []) {
    for (const { attribute } of attributes) {
      if (attribute.kind === '@attribute') {
        for (const param of attribute.params ?? []) {
          forEachReferencedIdentifier(param.expression, addName);
        }
      }
    }
  }

  for (const decl of declElements) {
    if (decl.kind === 'alias') {
      findImportsUsedInType(decl.typeRef);
    } else {
      findImportsUsedInAttributes(decl.attributes);
      for (const member of decl.members) {
        findImportsUsedInType(member.typeRef);
        findImportsUsedInAttributes(member.attributes);
      }
    }
  }

  for (const name of constReferences) {
    addName(name);
  }

  return { inlinedImports, directImports };
}

function parseImports(
  importElems: ImportElem[],
  directImports: Set<string>,
  inlinedImports: Set<string>,
  moduleSegments: string[],
): ImportedItem[] {
  const importOfAlias = generateImportMap(importElems, moduleSegments);
  const resultImports: ImportedItem[] = [];

  for (const identifier of directImports) {
    const resolved = assertDefined(importOfAlias.get(identifier));
    resultImports.push({
      path: toSpecifier(resolved, moduleSegments),
      item: assertDefined(resolved.segments.at(-1)),
      alias: identifier,
    });
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

    resultImports.push({
      path: toSpecifier(resolved, moduleSegments),
      item: assertDefined(splitInlined.at(-1)),
      alias: splitInlined.join('$'),
    });
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

/**
 * Generates one import statement per module, with the modules and the items
 * within each statement sorted, so the output is stable.
 */
function generateImports(importedItems: ImportedItem[]): string[] {
  const specifiersOfPath = new Map<string, Set<string>>();
  for (const { path, item, alias } of importedItems) {
    const specifiers = specifiersOfPath.get(path) ?? new Set<string>();
    specifiers.add(item === alias ? item : `${item} as ${alias}`);
    specifiersOfPath.set(path, specifiers);
  }

  return [...specifiersOfPath.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([path, specifiers]) => {
      const sorted = [...specifiers].sort(compare);
      return `import { ${sorted.join(', ')} } from '${path}.wesl?typegpu';`;
    });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

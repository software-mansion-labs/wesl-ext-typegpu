import type {
  AttributeElem,
  ImportElem,
  ImportStatement,
  TypeRefElem,
} from 'wesl';

import { forEachReferencedIdentifier } from './expressions.ts';
import { LIBRARY_DIR } from './libraries.ts';
import { type EmitNames, lazyGetterName } from './names.ts';
import type { TypeDeclElem } from './structs.ts';
import { asTypeRef } from './types.ts';
import { assertDefined } from './utils.ts';

/**
 * Where an import alias points to, as a file path relative to the WESL root, split into segments.
 * `package::`/`super::` are already resolved. Modules of WESL libraries live under
 * {@link LIBRARY_DIR}, e.g. `lygia::math::Foo` => `['__wesl_lib__', 'lygia', 'math', 'Foo']`.
 */
export interface ResolvedPath {
  kind: 'local' | 'library';
  segments: string[];
}

/**
 * The module being emitted, as file path segments relative to the WESL root.
 * `packageRoot` is what `package::` refers to: the WESL root itself for local modules,
 * or the library's directory for modules of a WESL library.
 */
export interface ModuleLocation {
  segments: string[];
  packageRoot: string[];
  /** Set for modules of WESL libraries, see `LibraryModule.libraryDirId` */
  libraryDirId?: string;
}

/** An item of a WESL library used by the emitted module. */
export interface LibraryReference {
  /** WESL path of the library module, e.g. `lygia::math` */
  modulePath: string;
  item: string;
  /** e.g. `struct member 'Struct.member'` or `alias 'Name'` */
  usedBy: string;
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
 * @param modulePath path of the module being emitted, e.g. `package::folder::main`,
 * or `lygia::math` for a module of a WESL library
 * @param libraryDirId set when emitting a module of a WESL library
 */
export function generateImportSnippets(
  declElems: TypeDeclElem[],
  importElems: ImportElem[],
  importsNamespace: Set<string>,
  modulePath: string,
  constReferences: Iterable<string>,
  names: EmitNames,
  libraryDirId?: string,
  lazyImports: Set<string> = new Set(),
): { snippets: string[]; libraryReferences: LibraryReference[] } {
  const { inlinedImports, directImports } = findImportsUsedInStructs(
    declElems,
    importsNamespace,
    constReferences,
  );

  const location = moduleLocation(modulePath, libraryDirId);

  const { importedItems, libraryReferences } = parseImports(
    importElems,
    directImports,
    inlinedImports,
    location,
    names,
    lazyImports,
  );
  return {
    snippets: [
      `import * as ${names.data} from 'typegpu/data';`,
      ...generateImports(importedItems),
    ],
    libraryReferences,
  };
}

/**
 * Finds imports used by the declarations and by the identifiers referenced by emitted consts.
 * Returns two maps, from the used names to the first declaration using them
 * (e.g. `struct member 'Struct.member'`), for error messages.
 * `directImports` contains identifiers of imported items, e.g. `struct1`.
 * `inlinedImports` contains names of inlined imports, e.g. `package::file::struct2`
 */
function findImportsUsedInStructs(
  declElements: TypeDeclElem[],
  importsNamespace: Set<string>,
  constReferences: Iterable<string>,
): {
  inlinedImports: Map<string, string>;
  directImports: Map<string, string>;
} {
  const directImports = new Map<string, string>();
  const inlinedImports = new Map<string, string>();

  function addName(name: string, usedBy: string) {
    if (name.includes('::') && !inlinedImports.has(name)) {
      inlinedImports.set(name, usedBy);
    }
    if (importsNamespace.has(name) && !directImports.has(name)) {
      directImports.set(name, usedBy);
    }
  }

  function findImportsUsedInType(typeRef: TypeRefElem, usedBy: string) {
    addName(typeRef.name.originalName, usedBy);
    for (const param of typeRef.templateParams ?? []) {
      const subtype = asTypeRef(param);
      if (subtype) {
        findImportsUsedInType(subtype, usedBy);
      } else {
        // e.g. the length of an array
        forEachReferencedIdentifier(param, (name) => addName(name, usedBy));
      }
    }
  }

  function findImportsUsedInAttributes(
    attributes: AttributeElem[] = [],
    usedBy: string,
  ) {
    for (const { attribute } of attributes) {
      if (attribute.kind === '@attribute') {
        for (const param of attribute.params ?? []) {
          forEachReferencedIdentifier(param.expression, (name) =>
            addName(name, usedBy),
          );
        }
      }
    }
  }

  for (const decl of declElements) {
    const name = decl.name.ident.originalName;
    if (decl.kind === 'alias') {
      findImportsUsedInType(decl.typeRef, `alias '${name}'`);
    } else {
      findImportsUsedInAttributes(decl.attributes, `struct '${name}'`);
      for (const member of decl.members) {
        const usedBy = `struct member '${name}.${member.name.name}'`;
        findImportsUsedInType(member.typeRef, usedBy);
        findImportsUsedInAttributes(member.attributes, usedBy);
      }
    }
  }

  for (const name of constReferences) {
    addName(name, 'a const declaration');
  }

  return { inlinedImports, directImports };
}

function parseImports(
  importElems: ImportElem[],
  directImports: Map<string, string>,
  inlinedImports: Map<string, string>,
  location: ModuleLocation,
  names: EmitNames,
  lazyImports: Set<string>,
): { importedItems: ImportedItem[]; libraryReferences: LibraryReference[] } {
  const importOfAlias = generateImportMap(importElems, location);
  const importedItems: ImportedItem[] = [];
  const libraryReferences: LibraryReference[] = [];

  function addImport(
    resolved: ResolvedPath,
    alias: string,
    usedBy: string,
    name: string,
  ) {
    const item = assertDefined(resolved.segments.at(-1));
    const path = toSpecifier(resolved, location);
    if (lazyImports.has(name)) {
      importedItems.push({
        path,
        item: lazyGetterName(item),
        alias: lazyGetterName(alias),
      });
      return;
    }
    importedItems.push({ path, item, alias });
    if (resolved.kind === 'library') {
      libraryReferences.push({
        modulePath: resolved.segments.slice(1, -1).join('::'),
        item,
        usedBy,
      });
    }
  }

  for (const [name, usedBy] of [...directImports, ...inlinedImports]) {
    addImport(
      assertDefined(resolveImportedName(name, importOfAlias, location)),
      importBinding(name, names),
      usedBy,
      name,
    );
  }

  return { importedItems, libraryReferences };
}

/**
 * The JS binding an imported name is emitted as, e.g. `Struct` for an imported identifier
 * or `package$file$Struct` for the inline path `package::file::Struct`.
 */
export function importBinding(name: string, names: EmitNames): string {
  return name.includes('::') ? name.replaceAll('::', '$') : names.local(name);
}

/**
 * Resolves a type name used in a module to the full path of the item it refers to.
 * Handles imported identifiers (`Struct`), paths extending an import (`module::Struct`)
 * and self-contained paths (`package::module::Struct`).
 * Returns undefined for names that are not imported.
 */
export function resolveImportedName(
  name: string,
  importOfAlias: Map<string, ResolvedPath>,
  location: ModuleLocation,
): ResolvedPath | undefined {
  const splitName = name.split('::');
  const [first, ...rest] = splitName;
  const aliased = importOfAlias.get(assertDefined(first));
  if (aliased) {
    // the name is imported directly, or extends an existing import
    // e.g. 'module::item' where 'module' is imported
    return { kind: aliased.kind, segments: [...aliased.segments, ...rest] };
  }
  if (rest.length > 0) {
    // the path is self-contained, e.g. 'package::item'
    return resolvePath(splitName, location);
  }
  return undefined;
}

export function moduleLocation(
  modulePath: string,
  libraryDirId?: string,
): ModuleLocation {
  const [root = '', ...rest] = modulePath.split('::');
  return root === 'package'
    ? { segments: rest, packageRoot: [] }
    : {
        segments: [LIBRARY_DIR, root, ...rest],
        packageRoot: [LIBRARY_DIR, root],
        libraryDirId,
      };
}

/** Returns the identifiers that the import statements bring into scope */
export function findOccupiedIdentifiers(
  importElems: ImportElem[],
): Set<string> {
  const imports = new Set<string>();

  function traverseImport(importElem: ImportStatement) {
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
 * Resolves a WESL path (e.g. `super::structs::StructA`) against the module it appears in.
 * `package` is the root of the module's package. The first `super` is the directory of the
 * current module, and every further `super` goes one directory up, matching the WESL linker.
 * Any other first segment names a WESL library.
 */
function resolvePath(
  segments: string[],
  location: ModuleLocation,
): ResolvedPath {
  const kind = location.packageRoot.length > 0 ? 'library' : 'local';
  const [first, ...rest] = segments;
  if (first === 'package') {
    return { kind, segments: [...location.packageRoot, ...rest] };
  }
  if (first === 'super') {
    let base = location.segments;
    let remaining = segments;
    while (remaining[0] === 'super') {
      if (base.length <= location.packageRoot.length) {
        throw new Error(
          `Import '${segments.join('::')}' in module '${describeModule(location)}' goes above the ${kind === 'local' ? 'WESL root' : 'library root'}`,
        );
      }
      base = base.slice(0, -1);
      remaining = remaining.slice(1);
    }
    return { kind, segments: [...base, ...remaining] };
  }
  return { kind: 'library', segments: [LIBRARY_DIR, ...segments] };
}

function describeModule({ segments, packageRoot }: ModuleLocation): string {
  return packageRoot.length > 0
    ? segments.slice(1).join('::')
    : ['package', ...segments].join('::');
}

/**
 * Turns the path of an imported item into a specifier for the module that holds it,
 * relative to the directory of the module being emitted.
 */
function toSpecifier(resolved: ResolvedPath, location: ModuleLocation) {
  const targetModule = resolved.segments.slice(0, -1);
  if (location.libraryDirId !== undefined) {
    // everything a library module imports lives in a library too
    return [location.libraryDirId, ...targetModule.slice(1)].join('/');
  }

  const currentDir = location.segments.slice(0, -1);
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
export function generateImportMap(
  importElems: ImportElem[],
  location: ModuleLocation,
): Map<string, ResolvedPath> {
  const importOfAlias = new Map<string, ResolvedPath>();

  function traverseImport(importElem: ImportStatement, prefix: string[]) {
    const path = [...prefix, ...importElem.segments.map((elem) => elem.name)];

    const segment = importElem.finalSegment;
    if (segment.kind === 'import-item') {
      const alias = segment.as ?? segment.name;
      importOfAlias.set(alias, resolvePath([...path, segment.name], location));
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

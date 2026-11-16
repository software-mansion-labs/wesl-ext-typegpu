import type {
  AliasElem,
  BatchModuleResolver,
  ConstElem,
  StructElem,
  WeslAST,
} from 'wesl';

import { type Conditions, validDecls } from './conditions.ts';
import { forEachReferencedIdentifier } from './expressions.ts';
import {
  type ModuleLocation,
  type ResolvedPath,
  generateImportMap,
  moduleLocation,
  resolveImportedName,
} from './imports.ts';

/** The declarations of a module that consts can refer to, and how the module resolves imported names. */
export interface ModuleScope {
  /** e.g. `package::folder::file`, or `lygia::math` for a module of a WESL library */
  path: string;
  location: ModuleLocation;
  importOfAlias: Map<string, ResolvedPath>;
  consts: Map<string, ConstElem>;
  structs: Map<string, StructElem>;
  aliases: Map<string, AliasElem>;
}

/** A declaration of another module, as referred to by an imported name. */
export interface ImportedDecl {
  module: string;
  name: string;
}

export function createModuleScope(
  path: string,
  ast: WeslAST,
  conditions: Conditions,
  libraryDirId?: string,
): ModuleScope {
  const location = moduleLocation(path, libraryDirId);
  const { imports, consts, structs, aliases } = validDecls(
    ast.moduleElem,
    conditions,
  );
  const byName = <T extends ConstElem | StructElem | AliasElem>(
    elems: T[],
  ): Map<string, T> =>
    new Map(
      elems.map((elem) => [
        elem.kind === 'const'
          ? elem.name.decl.ident.originalName
          : elem.name.ident.originalName,
        elem,
      ]),
    );
  return {
    path,
    location,
    importOfAlias: generateImportMap(imports, location),
    consts: byName(consts),
    structs: byName(structs),
    aliases: byName(aliases),
  };
}

/** The module and name of the declaration an imported name refers to. */
export function resolveImportedDecl(
  scope: ModuleScope,
  name: string,
): ImportedDecl | undefined {
  if (!(name.includes('::') || scope.importOfAlias.has(name))) {
    return undefined;
  }
  const resolved = resolveImportedName(
    name,
    scope.importOfAlias,
    scope.location,
  );
  return resolved && importedDeclOf(resolved);
}

export function importedDeclOf(resolved: ResolvedPath): ImportedDecl {
  return {
    module: modulePathOf({
      ...resolved,
      segments: resolved.segments.slice(0, -1),
    }),
    name: resolved.segments.at(-1) as string,
  };
}

/** The WESL path of a module (see {@link ModuleScope.path}) that an import points to, e.g. `import lygia::math;` */
export function modulePathOf(resolved: ResolvedPath): string {
  return (
    resolved.kind === 'local'
      ? ['package', ...resolved.segments]
      : // drops the `LIBRARY_DIR` segment
        resolved.segments.slice(1)
  ).join('::');
}

/**
 * The modules that consts can (transitively) refer to, so that the types of imported consts and structs can be inferred.
 * Local modules come from the registry, while modules of WESL libraries have to be loaded up front with {@link preloadLibraries}.
 */
export class ModuleGraph {
  readonly #scopes = new Map<string, ModuleScope | undefined>();
  readonly #libraries = new Map<string, WeslAST | undefined>();

  readonly registry: BatchModuleResolver;
  readonly conditions: Conditions;

  constructor(registry: BatchModuleResolver, conditions: Conditions) {
    this.registry = registry;
    this.conditions = conditions;
  }

  /** Registers a module that isn't in the registry, i.e. the emitted module when it's part of a library. */
  addScope(scope: ModuleScope): void {
    this.#scopes.set(scope.path, scope);
  }

  /** Returns undefined for modules that don't exist, or modules of WESL libraries that weren't preloaded. */
  scope(path: string): ModuleScope | undefined {
    if (!this.#scopes.has(path)) {
      const ast = path.startsWith('package::')
        ? this.registry.resolveModule(path)
        : this.#libraries.get(path);
      this.#scopes.set(
        path,
        ast && createModuleScope(path, ast, this.conditions),
      );
    }
    return this.#scopes.get(path);
  }

  /**
   * Loads the modules of WESL libraries that the consts of `scope` refer to, directly or through other modules.
   * Modules that fail to load are skipped, their declarations are then treated as unknown.
   */
  async preloadLibraries(
    scope: ModuleScope,
    loadLibraryModule: (modulePath: string) => Promise<WeslAST>,
  ): Promise<void> {
    const visited = new Set([scope.path]);
    const queue: [ModuleScope, boolean][] = [[scope, true]];
    for (let entry = queue.pop(); entry; entry = queue.pop()) {
      const [current, constsOnly] = entry;
      for (const name of referencedNames(current, constsOnly)) {
        const decl = resolveImportedDecl(current, name);
        if (!decl || visited.has(decl.module)) {
          continue;
        }
        visited.add(decl.module);
        if (
          !decl.module.startsWith('package::') &&
          !this.#libraries.has(decl.module)
        ) {
          this.#libraries.set(
            decl.module,
            await loadLibraryModule(decl.module).catch(() => undefined),
          );
        }
        const next = this.scope(decl.module);
        if (next) {
          queue.push([next, false]);
        }
      }
    }
  }
}

/** Names referenced by the declarations of a module that types of consts can depend on. */
function referencedNames(scope: ModuleScope, constsOnly: boolean): Set<string> {
  const names = new Set<string>();
  const visit = (name: string) => names.add(name);
  for (const elem of scope.consts.values()) {
    if (elem.init) {
      forEachReferencedIdentifier(elem.init, visit);
    }
    if (elem.name.typeRef) {
      forEachReferencedIdentifier(elem.name.typeRef, visit);
    }
  }
  if (!constsOnly) {
    for (const elem of scope.aliases.values()) {
      forEachReferencedIdentifier(elem.typeRef, visit);
    }
    for (const elem of scope.structs.values()) {
      for (const member of elem.members) {
        forEachReferencedIdentifier(member.typeRef, visit);
      }
    }
  }
  return names;
}

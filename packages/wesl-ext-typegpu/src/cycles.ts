import { type BatchModuleResolver, declsOfKind } from 'wesl';

import { ModuleTranslationError, formatLocation, locate } from './errors.ts';
import {
  findOccupiedIdentifiers,
  generateImportMap,
  moduleLocation,
  resolveImportedName,
} from './imports.ts';
import { type TypeDeclElem, declTypeNames } from './structs.ts';

/** A declaration referenced by a struct member or an alias */
interface Dependency {
  /** module path of the referenced declaration, e.g. `package::folder::file` */
  module: string;
  name: string;
  /** the name as written in the referencing module, e.g. `Alias` or `package::file::Struct` */
  writtenAs: string;
}

interface ModuleInfo {
  decls: Map<string, { elem: TypeDeclElem; dependencies: Dependency[] }>;
  /** paths of local modules that the emitted JS module imports declarations from */
  importedModules: Set<string>;
}

/**
 * Each emitted module eagerly creates its schemas in `export const`s, so two `?typegpu` modules that
 * import declarations from each other fail with a temporal dead zone error, whichever is evaluated first.
 *
 * This finds the modules that are in an import cycle with `modulePath`. If there are none, it returns
 * undefined and the module is emitted as usual. Otherwise it returns the names (as written in the module)
 * of the declarations imported from those modules, which the module has to read through their lazy getters.
 *
 * Throws if declarations from different modules of the cycle contain each other, since no order of
 * creating their schemas exists.
 */
export function findModuleCycle(
  modulePath: string,
  registry: BatchModuleResolver,
): { lazyImports: Set<string> } | undefined {
  const modules = new Map<string, ModuleInfo | undefined>();
  function getModule(path: string): ModuleInfo | undefined {
    if (!modules.has(path)) {
      modules.set(path, analyzeModule(path, registry));
    }
    return modules.get(path);
  }

  // modules that `modulePath` (transitively) imports from
  const reachable = new Set([modulePath]);
  const toVisit = [modulePath];
  for (let path = toVisit.pop(); path !== undefined; path = toVisit.pop()) {
    for (const imported of getModule(path)?.importedModules ?? []) {
      if (!reachable.has(imported)) {
        reachable.add(imported);
        toVisit.push(imported);
      }
    }
  }

  // of those, the ones that (transitively) import from `modulePath`
  const cycle = new Set([modulePath]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of reachable) {
      const importedModules = getModule(path)?.importedModules ?? new Set();
      if (!cycle.has(path) && !importedModules.isDisjointFrom(cycle)) {
        cycle.add(path);
        changed = true;
      }
    }
  }

  if (cycle.size === 1) {
    return undefined;
  }

  function dependenciesInCycle(path: string, name: string): Dependency[] {
    return (getModule(path)?.decls.get(name)?.dependencies ?? []).filter(
      (dep) =>
        cycle.has(dep.module) && getModule(dep.module)?.decls.has(dep.name),
    );
  }

  assertNoCrossModuleCycle(cycle, getModule, dependenciesInCycle);

  const lazyImports = new Set<string>();
  for (const name of getModule(modulePath)?.decls.keys() ?? []) {
    for (const dep of dependenciesInCycle(modulePath, name)) {
      if (dep.module !== modulePath) {
        lazyImports.add(dep.writtenAs);
      }
    }
  }
  return { lazyImports };
}

function assertNoCrossModuleCycle(
  cycle: Set<string>,
  getModule: (path: string) => ModuleInfo | undefined,
  dependenciesInCycle: (path: string, name: string) => Dependency[],
) {
  const done = new Set<string>();
  const stack: { key: string; module: string; name: string }[] = [];

  function visit(module: string, name: string) {
    const key = `${module}::${name}`;
    const onStack = stack.findIndex((entry) => entry.key === key);
    if (onStack !== -1) {
      const members = stack.slice(onStack);
      // cycles within a single module are reported when sorting its declarations
      if (members.some((member) => member.module !== module)) {
        const first = getModule(module)?.decls.get(name)?.elem as TypeDeclElem;
        const names = [...members, members[0]].map((member) => member.key);
        throw new ModuleTranslationError(
          `${formatLocation(locate(first, first.start))}: Cyclic dependency between types from different modules: ${names.join(' -> ')}`,
        );
      }
      return;
    }
    if (done.has(key)) {
      return;
    }
    stack.push({ key, module, name });
    for (const dep of dependenciesInCycle(module, name)) {
      visit(dep.module, dep.name);
    }
    stack.pop();
    done.add(key);
  }

  for (const module of cycle) {
    for (const name of getModule(module)?.decls.keys() ?? []) {
      visit(module, name);
    }
  }
}

function analyzeModule(
  modulePath: string,
  registry: BatchModuleResolver,
): ModuleInfo | undefined {
  const ast = registry.resolveModule(modulePath);
  if (!ast) {
    return undefined;
  }
  const location = moduleLocation(modulePath);
  const importElems = declsOfKind(ast.moduleElem, 'import');
  const declElems: TypeDeclElem[] = [
    ...declsOfKind(ast.moduleElem, 'struct'),
    ...declsOfKind(ast.moduleElem, 'alias'),
  ];

  const importsNamespace = findOccupiedIdentifiers(importElems);
  const importOfAlias = generateImportMap(importElems, location);
  const declNames = new Set(
    declElems.map((decl) => decl.name.ident.originalName),
  );

  const decls: ModuleInfo['decls'] = new Map();
  const importedModules = new Set<string>();

  for (const elem of declElems) {
    const dependencies: Dependency[] = [];
    for (const typeName of declTypeNames(elem)) {
      // same precedence as `generateType`: imports first, then declarations of this module
      if (importsNamespace.has(typeName) || typeName.includes('::')) {
        const resolved = resolveImportedName(typeName, importOfAlias, location);
        if (resolved?.kind !== 'local') {
          continue;
        }
        const module = ['package', ...resolved.segments.slice(0, -1)].join(
          '::',
        );
        importedModules.add(module);
        dependencies.push({
          module,
          name: resolved.segments.at(-1) as string,
          writtenAs: typeName,
        });
      } else if (declNames.has(typeName)) {
        dependencies.push({
          module: modulePath,
          name: typeName,
          writtenAs: typeName,
        });
      }
    }
    decls.set(elem.name.ident.originalName, { elem, dependencies });
  }

  return { decls, importedModules };
}

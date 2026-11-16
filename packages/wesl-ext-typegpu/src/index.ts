import { type WeslAST, fileToModulePath } from 'wesl';
import type { PluginExtensionApi } from 'wesl-plugin';

import { type Conditions, conditionsQuery, validDecls } from './conditions.ts';
import { translateConsts } from './consts.ts';
import { findModuleCycle } from './cycles.ts';
import { ModuleTranslationError } from './errors.ts';
import {
  type LibraryReference,
  generateImportMap,
  generateImportSnippets,
  moduleLocation,
} from './imports.ts';
import {
  libraryModuleOfShaderPath,
  resolveLibraryModule,
} from './libraries.ts';
import { createEmitNames } from './names.ts';
import { ModuleGraph, createModuleScope } from './scope.ts';
import { generateStructSnippets } from './structs.ts';

export const typegpuExtension: {
  extensionName: 'typegpu';
  emitFn: typeof emitReflectJs;
} = {
  extensionName: 'typegpu',
  emitFn: emitReflectJs,
};

async function emitReflectJs(
  baseId: string,
  api: PluginExtensionApi,
  conditions: Conditions = {},
): Promise<string> {
  const { moduleName, ast, libraryDirId } = await resolveEmittedModule(
    baseId,
    api,
  );

  const { imports, structs, aliases, consts } = validDecls(
    ast.moduleElem,
    conditions,
  );
  const typeDecls = [...structs, ...aliases];

  const location = moduleLocation(moduleName, libraryDirId);
  const importOfAlias = generateImportMap(imports, location);
  const importsNamespace = new Set(importOfAlias.keys());

  const names = createEmitNames([
    ...importsNamespace,
    ...typeDecls.map((decl) => decl.name.ident.originalName),
    ...consts.map((elem) => elem.name.decl.ident.originalName),
  ]);

  const registry = await api.weslRegistry();
  // Modules of WESL libraries can't import from the user's modules, and cycles within a library aren't handled (yet).
  const cycle =
    libraryDirId === undefined
      ? findModuleCycle(moduleName, registry, conditions)
      : undefined;
  const lazyImports = cycle?.lazyImports;

  const graph = new ModuleGraph(registry, conditions);
  const scope = createModuleScope(moduleName, ast, conditions, libraryDirId);
  graph.addScope(scope);
  await graph.preloadLibraries(scope, async (modulePath) => {
    const { tomlDir } = await api.weslToml();
    return resolveLibraryModule(modulePath, tomlDir);
  });

  const translatedConsts = translateConsts(scope, graph, names, cycle);
  const {
    snippets: structSnippets,
    translated,
    errors,
  } = generateStructSnippets(
    typeDecls,
    importsNamespace,
    translatedConsts.ctx,
    lazyImports,
  );
  // Consts created from structs that cannot be translated are skipped, since the placeholders throw when used.
  const emittedConsts = translatedConsts.emit(
    new Set(errors.map((error) => error.declName)),
  );

  // Declarations that failed to translate are emitted as throwing placeholders, so they don't need any imports.
  // This also keeps a broken declaration from pulling in an import that can't be resolved.
  const { snippets: importSnippets, libraryReferences } =
    generateImportSnippets(
      translated,
      importOfAlias,
      importsNamespace,
      location,
      emittedConsts.referencedIdentifiers,
      names,
      conditionsQuery(conditions),
      lazyImports && lazyImports.union(emittedConsts.lazyImports),
      emittedConsts.early.length + emittedConsts.late.length > 0,
    );
  await checkLibraryReferences(libraryReferences, api, conditions);

  // `PluginExtensionApi` doesn't expose the bundler's `this.warn`, so this is the best we can do at build time.
  for (const error of errors) {
    console.warn(`[wesl-ext-typegpu] ${error.message}`);
  }

  const src = [
    ...importSnippets,
    ...emittedConsts.early,
    ...structSnippets,
    ...emittedConsts.late,
  ].join('\n');

  return src;
}

async function resolveEmittedModule(
  baseId: string,
  api: PluginExtensionApi,
): Promise<{ moduleName: string; ast: WeslAST; libraryDirId?: string }> {
  const libraryModule = libraryModuleOfShaderPath(baseId);
  if (libraryModule) {
    const { modulePath, libraryDirId } = libraryModule;
    const { tomlDir } = await api.weslToml();
    return {
      moduleName: modulePath,
      ast: await resolveLibraryModule(modulePath, tomlDir),
      libraryDirId,
    };
  }

  const rootModule = await api.weslMain(baseId);
  const moduleName = fileToModulePath(rootModule, 'package', false);

  const registry = await api.weslRegistry();
  const ast = registry.resolveModule(moduleName);
  if (!ast) {
    throw new ModuleTranslationError(
      `Unable to resolve WESL module '${moduleName}' (${rootModule}), imported as '${baseId}'`,
    );
  }
  return { moduleName, ast };
}

/**
 * Library modules are emitted lazily, once the bundler follows the import to them.
 * Resolving them up front lets us point at the declaration that uses a missing library or item.
 */
async function checkLibraryReferences(
  references: LibraryReference[],
  api: PluginExtensionApi,
  conditions: Conditions,
): Promise<void> {
  if (references.length === 0) {
    return;
  }
  const { tomlDir } = await api.weslToml();
  for (const { modulePath, item, usedBy } of references) {
    const ast = await resolveLibraryModule(modulePath, tomlDir, usedBy);
    const { structs, aliases, consts } = validDecls(ast.moduleElem, conditions);
    const declared = [
      ...[...structs, ...aliases].map((decl) => decl.name.ident.originalName),
      ...consts.map((decl) => decl.name.decl.ident.originalName),
    ];
    if (!declared.includes(item)) {
      throw new Error(
        `WESL library module '${modulePath}' has no struct, alias or const '${item}' (used by ${usedBy})`,
      );
    }
  }
}

import {
  type ImportElem,
  type ImportStatement,
  type WeslAST,
  declsOfKind,
  fileToModulePath,
} from 'wesl';
import type { PluginExtensionApi } from 'wesl-plugin';

import { translateConsts } from './consts.ts';
import { type LibraryReference, generateImportSnippets } from './imports.ts';
import {
  libraryModuleOfShaderPath,
  resolveLibraryModule,
} from './libraries.ts';
import { createEmitNames } from './names.ts';
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
): Promise<string> {
  const { moduleName, ast, libraryDirId } = await resolveEmittedModule(
    baseId,
    api,
  );

  const imports = declsOfKind(ast.moduleElem, 'import');
  const structs = declsOfKind(ast.moduleElem, 'struct');
  const aliases = declsOfKind(ast.moduleElem, 'alias');
  const typeDecls = [...structs, ...aliases];
  const consts = declsOfKind(ast.moduleElem, 'const');

  const importsNamespace = findOccupiedIdentifiers(imports);

  const names = createEmitNames([
    ...importsNamespace,
    ...typeDecls.map((decl) => decl.name.ident.originalName),
    ...consts.map((elem) => elem.name.decl.ident.originalName),
  ]);

  const translatedConsts = translateConsts(consts, importsNamespace, names);
  const { snippets: importSnippets, libraryReferences } =
    generateImportSnippets(
      typeDecls,
      imports,
      importsNamespace,
      moduleName,
      translatedConsts.referencedIdentifiers,
      names,
      libraryDirId,
    );
  await checkLibraryReferences(libraryReferences, api);
  const structSnippets = generateStructSnippets(
    typeDecls,
    importsNamespace,
    translatedConsts.ctx,
  );

  const src = [
    ...importSnippets,
    ...translatedConsts.snippets,
    ...structSnippets,
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
    throw new Error(`Unable to resolve WESL module '${moduleName}'!`);
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
): Promise<void> {
  if (references.length === 0) {
    return;
  }
  const { tomlDir } = await api.weslToml();
  for (const { modulePath, item, usedBy } of references) {
    const ast = await resolveLibraryModule(modulePath, tomlDir, usedBy);
    const declared = [
      ...declsOfKind(ast.moduleElem, 'struct').map(
        (decl) => decl.name.ident.originalName,
      ),
      ...declsOfKind(ast.moduleElem, 'alias').map(
        (decl) => decl.name.ident.originalName,
      ),
      ...declsOfKind(ast.moduleElem, 'const').map(
        (decl) => decl.name.decl.ident.originalName,
      ),
    ];
    if (!declared.includes(item)) {
      throw new Error(
        `WESL library module '${modulePath}' has no struct, alias or const '${item}' (used by ${usedBy})`,
      );
    }
  }
}

function findOccupiedIdentifiers(importElems: ImportElem[]) {
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

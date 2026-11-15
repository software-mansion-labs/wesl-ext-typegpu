import { pathToFileURL } from 'node:url';

import { resolve } from 'import-meta-resolve';
import {
  type WeslAST,
  type WeslBundle,
  composeResolvers,
  createLibraryResolvers,
  npmNameVariations,
} from 'wesl';

/**
 * Modules of WESL libraries have no file of their own, so emitted imports address them
 * as if they lived in this directory under the WESL root, e.g. `lygia::math` becomes
 * `<weslRoot>/__wesl_lib__/lygia/math.wesl?typegpu`. wesl-plugin resolves such a specifier
 * like any other `?typegpu` import and hands the path back to our `emitFn`, which
 * recognises the directory and reads the module from the library's WeslBundle instead.
 */
export const LIBRARY_DIR = '__wesl_lib__';

export interface LibraryModule {
  /** WESL path of the library module, e.g. `lygia::math` */
  modulePath: string;
  /**
   * The id wesl-plugin resolved {@link LIBRARY_DIR} to, e.g. `^^/project/shaders/__wesl_lib__`.
   * Library modules import each other by this exact id: wesl-plugin passes ids starting with `^^`
   * through unchanged, while a relative specifier would be joined onto the importer's id, `^^` included,
   * loading the same library module again under a different id (and so with different schema objects).
   */
  libraryDirId: string;
}

/**
 * If `shaderPath` points into {@link LIBRARY_DIR}, returns the library module it addresses,
 * e.g. `/project/shaders/__wesl_lib__/lygia/math.wesl` => `lygia::math`.
 */
export function libraryModuleOfShaderPath(
  shaderPath: string,
): LibraryModule | undefined {
  const segments = shaderPath.replace(/\.w[eg]sl$/, '').split(/[\\/]/);
  const libDirIndex = segments.lastIndexOf(LIBRARY_DIR);
  if (libDirIndex === -1 || libDirIndex === segments.length - 1) {
    return undefined;
  }
  const libraryDir = segments
    .slice(0, libDirIndex + 1)
    .join('/')
    .replace(/^\^*/, '');
  return {
    modulePath: segments.slice(libDirIndex + 1).join('::'),
    libraryDirId: `^^${libraryDir}`,
  };
}

const bundleCache = new Map<string, Promise<WeslBundle>>();

async function loadBundle(url: string): Promise<WeslBundle> {
  let bundle = bundleCache.get(url);
  if (!bundle) {
    bundle = import(url).then((exports: { default?: WeslBundle }) => {
      if (!exports.default?.modules) {
        throw new Error(`'${url}' does not export a WeslBundle by default`);
      }
      return exports.default;
    });
    bundleCache.set(url, bundle);
  }
  return bundle;
}

/**
 * Finds the npm package that provides a WESL library module, the same way wesl-plugin
 * discovers library dependencies: the longest resolvable npm subpath of the module path wins.
 *
 * @param modulePath e.g. `lygia::math`
 * @param projectDir directory to resolve npm packages from (the directory of wesl.toml)
 * @param usage describes where the module is used, for error messages
 */
export async function resolveLibraryModule(
  modulePath: string,
  projectDir: string,
  usage?: string,
): Promise<WeslAST> {
  const segments = modulePath.split('::');
  const projectURL = pathToFileURL(
    projectDir.endsWith('/') ? projectDir : `${projectDir}/`,
  ).href;
  const usedBy = usage ? ` (used by ${usage})` : '';

  for (let length = segments.length; length > 0; length--) {
    const subPath = segments.slice(0, length).join('/');
    for (const npmPath of npmNameVariations(subPath)) {
      let url: string;
      try {
        url = resolve(npmPath, projectURL);
      } catch {
        continue;
      }

      const bundle = await loadBundle(url);
      const resolver = composeResolvers(...createLibraryResolvers([bundle]));
      const ast = resolver.resolveModule(modulePath);
      if (!ast) {
        throw new Error(
          `WESL library '${npmPath}' has no module '${modulePath}'${usedBy}`,
        );
      }
      return ast;
    }
  }

  throw new Error(
    `Unable to find the WESL library for module '${modulePath}'${usedBy}. ` +
      `Is the npm package '${[...npmNameVariations(segments[0] ?? modulePath)][0]}' installed?`,
  );
}

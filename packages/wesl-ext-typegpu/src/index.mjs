// @ts-check

import path from "node:path";
import {
  genImport,
  genObjectFromRaw,
  genObjectFromRawEntries,
  genString,
} from "knitwork";
import { noSuffix } from "wesl";

/** @type {import("wesl-plugin").PluginExtension} */
export const typegpuExtension = {
  extensionName: "typegpu",
  emitFn: emitReflectJs,
};

/**
 * @param {string} baseId
 * @param {import("wesl-plugin").PluginExtensionApi} api
 * @returns {Promise<string>}
 */
async function emitReflectJs(baseId, api) {
  const { resolvedWeslRoot, toml, tomlDir } = await api.weslToml();
  const { dependencies = [] } = toml;

  const rootModule = await api.weslMain(baseId);
  const rootModuleName = noSuffix(rootModule);

  const registry = await api.weslRegistry();

  const tomlRelative = path.relative(tomlDir, resolvedWeslRoot);
  const debugWeslRoot = tomlRelative.replaceAll(path.sep, "/");

  const bundleImports = dependencies
    .map((p) => genImport(`${p}?typegpu`, p))
    .join("\n");

  /** @type {string[]} */
  const snippets = [genImport("typegpu/data", "* as d")];

  const rootName = path.basename(rootModuleName);

  for (const elem of registry.modules[`package::${rootName}`].moduleElem
    .contents) {
    if (elem.kind === "struct") {
      const fieldsCode = genObjectFromRawEntries(
        elem.members.map((member) => {
          return /** @type {[string, string]} */ ([
            member.name.name,
            // TODO: Resolve custom data-types properly
            `d.${member.typeRef.name.originalName}`,
          ]);
        }),
      );
      snippets.push(
        `export const ${elem.name.ident.originalName} = d.struct(${fieldsCode}).$name(${genString(elem.name.ident.originalName)});`,
      );
    }
  }

  const src = `${bundleImports}\n${snippets.join("\n")}`;

  console.log(src);

  return src;
}

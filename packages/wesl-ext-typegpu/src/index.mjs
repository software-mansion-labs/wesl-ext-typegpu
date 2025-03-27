// @ts-check

import path from 'node:path';
import {
  genImport,
  genObjectFromRaw,
  genObjectFromRawEntries,
  genString,
} from 'knitwork';
import { attributeToString, noSuffix } from 'wesl';

/** @typedef {import("wesl").WeslAST['moduleElem']['contents'][number]} AbstractElem */
/** @typedef {Extract<AbstractElem, { kind: 'struct' }>} StructElem */
/** @typedef {StructElem['members'][number]} StructMemberElem */
/** @typedef {Extract<StructMemberElem['attributes'], {}>[number]} AttributeElem */
/** @typedef {StructMemberElem['typeRef']} TypeRefElem */

/** @type {import("wesl-plugin").PluginExtension} */
export const typegpuExtension = {
  extensionName: 'typegpu',
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
  const debugWeslRoot = tomlRelative.replaceAll(path.sep, '/');

  const bundleImports = dependencies
    .map((p) => genImport(`${p}?typegpu`, p))
    .join('\n');

  /** @type {string[]} */
  const snippets = [genImport('typegpu/data', '* as d')];

  const rootName = path.basename(rootModuleName);

  for (const elem of registry.modules[`package::${rootName}`].moduleElem
    .contents) {
    if (elem.kind === 'struct') {
      snippets.push(generateStruct(elem));
    }
  }

  const src = `${bundleImports}\n${snippets.join('\n')}`;

  console.log(src);

  return src;
}

/**
 * @param {StructElem} struct
 */
function generateStruct(struct) {
  const name = struct.name.ident.originalName;
  const fieldsCode = genObjectFromRawEntries(
    struct.members.map((member) => generateMember(member)),
  );
  return `export const ${name} = d.struct(${fieldsCode}).$name(${genString(name)});`;
}

/**
 * @param {StructMemberElem} member
 */
function generateMember(member) {
  return /** @type {[string, string]} */ ([
    member.name.name,
    // TODO: Resolve custom data-types properly
    generateType(member.typeRef, member.attributes),
  ]);
}

/**
 * @param {TypeRefElem} typeRef
 * @param {AttributeElem[] | undefined} attributes
 */
function generateType(typeRef, attributes) {
  const tgpuType = `d.${typeRef.name.originalName}`;

  const result =
    attributes?.reduce((acc, attributeElem) => {
      const attribute = attributeElem.attribute;

      if (attribute.kind === '@attribute') {
        console.log(attributeToString(attribute));
        let attributeString = attributeToString(attribute);
        attributeString = attributeString.replace(' @', '');
        attributeString = attributeString.replace(')', `, ${acc})`);
        return `d.${attributeString}`;
      }
      return acc;
    }, tgpuType) ?? tgpuType;

  return result;
}

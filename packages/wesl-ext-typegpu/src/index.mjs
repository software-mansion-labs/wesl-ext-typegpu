// @ts-check
// AAA structy też mogą mieć atrybuty

import path from 'node:path';
import { genImport, genObjectFromRawEntries, genString } from 'knitwork';
import { noSuffix } from 'wesl';

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").StructElem} StructElem */
/** @typedef {import("wesl").StructMemberElem} StructMemberElem */
/** @typedef {import("wesl").AttributeElem} AttributeElem */
/** @typedef {import("wesl").TypeRefElem} TypeRefElem */
/** @typedef {import("wesl").ImportElem} ImportElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */

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

  const abstractElements =
    registry.modules[`package::${rootName}`].moduleElem.contents;

  const sortedStructs = sortStructs(abstractElements);

  for (const elem of sortedStructs) {
    snippets.push(generateStruct(elem));
  }

  const src = `${bundleImports}\n${snippets.join('\n')}`;

  console.log(src);

  return src;
}

/**
 * @param {AbstractElem[]} abstractElements
 */
function sortStructs(abstractElements) {
  /** @type {Map<string, StructElem>} */
  const definedStructElements = new Map(
    abstractElements
      .filter((elem) => elem.kind === 'struct')
      .map((struct) => [struct.name.ident.originalName, struct]),
  );

  const definedStructIdentifiers = new Set(definedStructElements.keys());

  /** @type {Map<string, number>} */
  const dependenciesLeft = new Map(
    definedStructIdentifiers.values().map((identifier) => [identifier, 0]),
  );
  /** @type {Map<string, Set<string>>} */
  const dependencyOf = new Map(
    definedStructIdentifiers
      .values()
      .map((identifier) => [identifier, new Set()]),
  );

  for (const [identifier, struct] of definedStructElements) {
    const dependencies = findNeighborStructs(struct, definedStructIdentifiers);
    dependenciesLeft.set(identifier, dependencies.size);

    for (const neighbor of dependencies) {
      dependencyOf.get(neighbor)?.add(identifier);
    }
  }

  /** @type {string[]} */
  const queue = dependenciesLeft
    .entries()
    .filter(([_, dependencies]) => dependencies === 0)
    .map(([key, _]) => key)
    .toArray();
  const visited = new Set();
  /** @type {StructElem[]} */
  const orderedStructs = [];

  while (queue.length > 0) {
    // TODO: optimize this shift
    const current = /** @type {string} */ (queue.shift());
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    orderedStructs.push(
      /** @type {StructElem} */ (definedStructElements.get(current)),
    );

    for (const neighbor of dependencyOf.get(current) ?? []) {
      const count = /** @type {number} */ (dependenciesLeft.get(neighbor));
      dependenciesLeft.set(neighbor, count - 1);
      if (count === 1) {
        queue.push(neighbor);
      }
    }
  }

  if (visited.size !== definedStructIdentifiers.size) {
    throw new Error('Cyclic dependency in struct member types detected!');
  }

  return orderedStructs;
}

/**
 * @param {StructElem} struct
 * @param {Set<string>} relevantIdentifiers
 */
function findNeighborStructs(struct, relevantIdentifiers) {
  const neighbors = new Set();
  for (const member of struct.members) {
    findTypeReferences(member.typeRef, neighbors);
  }
  return neighbors.intersection(relevantIdentifiers);
}

/**
 * @param {AbstractElem[]} elements
 */
function findAllImports(elements) {
  const imports = new Set();
  for (const elem of elements) {
    if (elem.kind === 'import') {
      traverseImport(elem.imports, imports);
    }
  }
  return imports;
}

/**
 * @param {ImportStatement} importElem
 * @param {Set<string>} importsSet
 */
function traverseImport(importElem, importsSet) {
  const segment = importElem.finalSegment;
  if (segment.kind === 'import-item') {
    importsSet.add(segment.name);
  } else {
    for (const subImport of segment.subtrees) {
      traverseImport(subImport, importsSet);
    }
  }
}

/**
 * @param {TypeRefElem} type
 * @param {Set<string>} referencesSet
 */
function findTypeReferences(type, referencesSet) {
  referencesSet.add(type.name.originalName);
  for (const elem of type.templateParams ?? []) {
    if ('kind' in elem && elem.kind === 'type') {
      findTypeReferences(elem, referencesSet);
    }
  }
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
  const set = new Set();
  findTypeReferences(typeRef, set);
  console.log(set);

  const result =
    attributes?.reduce((acc, attributeElem) => {
      const attribute = attributeElem.attribute;
      // if (attribute.kind === '@attribute') {
      //   console.log(attributeToString(attribute));
      //   let attributeString = attributeToString(attribute);
      //   attributeString = attributeString.replace(' @', '');
      //   attributeString = attributeString.replace(')', `, ${acc})`);
      //   return `d.${attributeString}`;
      // }
      return acc;
    }, tgpuType) ?? tgpuType;

  return result;
}

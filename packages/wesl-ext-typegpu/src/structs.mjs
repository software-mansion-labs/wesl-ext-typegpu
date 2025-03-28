// @ts-check

import { genObjectFromRawEntries, genString } from 'knitwork';

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").StructElem} StructElem */
/** @typedef {import("wesl").StructMemberElem} StructMemberElem */
/** @typedef {import("wesl").AttributeElem} AttributeElem */
/** @typedef {import("wesl").TypeRefElem} TypeRefElem */
/** @typedef {import("wesl").ImportElem} ImportElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */

/**
 * @param {StructElem[]} structElements
 */
export function sortStructs(structElements) {
  /** @type {Map<string, StructElem>} */
  const definedStructElements = new Map(
    structElements.map((struct) => [struct.name.ident.originalName, struct]),
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
 * @param {Set<string>} nonTgpuIdentifiers
 */
export function generateStruct(struct, nonTgpuIdentifiers) {
  const name = struct.name.ident.originalName;
  const fieldsCode = genObjectFromRawEntries(
    struct.members.map((member) => generateMember(member, nonTgpuIdentifiers)),
  );
  return `export const ${name} = d.struct(${fieldsCode}).$name(${genString(name)});`;
}

/**
 * @param {StructMemberElem} member
 * @param {Set<string>} nonTgpuIdentifiers
 */
function generateMember(member, nonTgpuIdentifiers) {
  return /** @type {[string, string]} */ ([
    member.name.name,
    // TODO: Resolve custom data-types properly
    generateType(member.typeRef, member.attributes, nonTgpuIdentifiers),
  ]);
}

/**
 * @param {TypeRefElem} typeRef
 * @param {AttributeElem[] | undefined} attributes
 * @param {Set<string>} nonTgpuIdentifiers
 */
function generateType(typeRef, attributes, nonTgpuIdentifiers) {
  const typeName = typeRef.name.originalName;
  const tgpuType =
    !nonTgpuIdentifiers.has(typeName) && !typeName.includes('::');

  if (!tgpuType) {
    return typeName;
  }

  if (['vec2', 'vec3', 'vec4'].includes(typeName)) {
    if (
      !typeRef.templateParams ||
      typeRef.templateParams.length !== 1 ||
      typeRef.templateParams[0].kind !== 'type' ||
      !(typeRef.templateParams[0].name.originalName in vecResolveMap)
    ) {
      throw new Error('Unsupported vector parameters!');
    }
    return `d.${typeName}${vecResolveMap[typeRef.templateParams[0].name.originalName]}`;
  }

  return `d.${typeName}`;
}

/** @type {Record<string, string>} */
const vecResolveMap = {
  bool: 'b',
  AbstractInt: 'i',
  AbstractFloat: 'f',
  i32: 'i',
  u32: 'u',
  f32: 'f',
  f16: 'h',
};

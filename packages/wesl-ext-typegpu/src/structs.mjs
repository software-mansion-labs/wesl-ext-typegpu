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
 */
export function generateStruct(struct) {
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

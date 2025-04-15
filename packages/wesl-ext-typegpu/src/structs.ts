import { genObjectFromRawEntries, genString } from "knitwork";
import type { StructElem, StructMemberElem, TypeRefElem } from "wesl";
import { Queue } from "./queue.ts";
import {
  VariableSizedArrayParam,
  generateType,
  wrapInAttributes,
} from "./types.ts";

export function generateStructSnippets(
  structElems: StructElem[],
  importsNamespace: Set<string>,
): string[] {
  const sortedStructs = sortStructs(structElems);

  // We need to know which type identifiers are in typegpu/std and need to be prepended with 'd.'.
  // Our approach is to find all type identifiers in the namespace introduced by imports and defined structs
  // and to prepend everything else (that is not an inlined import) with 'd.'.
  const nonTgpuIdentifiers: Set<string> = new Set(
    sortedStructs.map((struct) => struct.name.ident.originalName),
  ).union(importsNamespace);

  return sortedStructs.map((elem) => generateStruct(elem, nonTgpuIdentifiers));
}

function sortStructs(structElements: StructElem[]): StructElem[] {
  const definedStructElements: Map<string, StructElem> = new Map(
    structElements.map((struct) => [struct.name.ident.originalName, struct]),
  );

  const definedStructIdentifiers = new Set(definedStructElements.keys());

  const dependenciesLeft: Map<string, number> = new Map(
    definedStructIdentifiers.values().map((identifier) => [identifier, 0]),
  );
  const dependencyOf: Map<string, Set<string>> = new Map(
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

  const queue: Queue<string> = new Queue(
    dependenciesLeft
      .entries()
      .filter(([_, dependencies]) => dependencies === 0)
      .map(([key, _]) => key)
      .toArray(),
  );
  const visited = new Set();
  const orderedStructs: StructElem[] = [];

  while (queue.length > 0) {
    const current = queue.remove() as string;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    orderedStructs.push(definedStructElements.get(current) as StructElem);

    for (const neighbor of dependencyOf.get(current) ?? []) {
      const count = dependenciesLeft.get(neighbor) as number;
      dependenciesLeft.set(neighbor, count - 1);
      if (count === 1) {
        queue.add(neighbor);
      }
    }
  }

  if (visited.size !== definedStructIdentifiers.size) {
    throw new Error("Cyclic dependency in struct member types detected!");
  }

  return orderedStructs;
}

function findNeighborStructs(
  struct: StructElem,
  relevantIdentifiers: Set<string>,
): Set<string> {
  const neighbors: Set<string> = new Set();

  function findTypeReferences(type: TypeRefElem) {
    const name = type.name.originalName;
    if (relevantIdentifiers.has(name)) {
      neighbors.add(name);
    }
    for (const elem of type.templateParams ?? []) {
      if ("kind" in elem && elem.kind === "type") {
        findTypeReferences(elem);
      }
    }
  }

  for (const member of struct.members) {
    findTypeReferences(member.typeRef);
  }
  return neighbors;
}

export function generateStruct(
  struct: StructElem,
  nonTgpuIdentifiers: Set<string>,
): string {
  const name = struct.name.ident.originalName;
  const fieldsCode = genObjectFromRawEntries(
    struct.members.map((member) => generateMember(member, nonTgpuIdentifiers)),
  );
  let structDefinition = wrapInAttributes(
    `d.struct(${fieldsCode}).$name(${genString(name)})`,
    struct.attributes,
  );
  if (isVariableLength(struct)) {
    structDefinition = `(${VariableSizedArrayParam} => ${structDefinition})`;
  }
  return `export const ${name} = ${structDefinition};`;
}

function generateMember(
  member: StructMemberElem,
  nonTgpuIdentifiers: Set<string>,
): [string, string] {
  return [
    member.name.name,
    wrapInAttributes(
      generateType(member.typeRef, nonTgpuIdentifiers),
      member.attributes,
    ),
  ];
}

function isVariableLength(struct: StructElem): boolean {
  const lastMember = struct.members.at(-1);
  return (
    !!lastMember &&
    lastMember.typeRef.name.originalName === "array" &&
    !!lastMember.typeRef.templateParams &&
    lastMember.typeRef.templateParams.length === 1
  );
}

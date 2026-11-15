import { genObjectFromRawEntries, genString } from 'knitwork';
import type {
  AliasElem,
  StructElem,
  StructMemberElem,
  TypeRefElem,
} from 'wesl';

import { Queue } from './queue.ts';
import {
  VariableSizedArrayParam,
  asTypeRef,
  generateType,
  wrapInAttributes,
} from './types.ts';

/** A module-level declaration that is emitted as an exported TypeGPU schema. */
export type TypeDeclElem = StructElem | AliasElem;

export function generateStructSnippets(
  declElems: TypeDeclElem[],
  importsNamespace: Set<string>,
): string[] {
  const sortedDecls = sortDecls(declElems);

  // We need to know which type identifiers are in typegpu/std and need to be prepended with 'd.'.
  // Our approach is to find all type identifiers in the namespace introduced by imports, defined structs
  // and defined aliases, and to prepend everything else (that is not an inlined import) with 'd.'.
  const nonTgpuIdentifiers: Set<string> = new Set(
    sortedDecls.map(declName),
  ).union(importsNamespace);

  // Aliases of runtime-sized arrays, e.g. `alias Arr = array<f32>;`.
  // They are emitted as functions of the array length, just like runtime-sized structs.
  // Filled in dependency order, so aliases of aliases are detected as well.
  const runtimeSizedAliases = new Set<string>();

  return sortedDecls.map((elem) => {
    if (elem.kind === 'alias') {
      if (isRuntimeSized(elem.typeRef, runtimeSizedAliases)) {
        runtimeSizedAliases.add(declName(elem));
      }
      return generateAlias(elem, nonTgpuIdentifiers);
    }
    return generateStruct(elem, nonTgpuIdentifiers, runtimeSizedAliases);
  });
}

function declName(decl: TypeDeclElem): string {
  return decl.name.ident.originalName;
}

/** Type references a declaration depends on. */
function typeRefsOf(decl: TypeDeclElem): TypeRefElem[] {
  return decl.kind === 'alias'
    ? [decl.typeRef]
    : decl.members.map((member) => member.typeRef);
}

function sortDecls(declElements: TypeDeclElem[]): TypeDeclElem[] {
  const definedDeclElements: Map<string, TypeDeclElem> = new Map(
    declElements.map((decl) => [declName(decl), decl]),
  );

  const definedIdentifiers = new Set(definedDeclElements.keys());

  const dependenciesLeft: Map<string, number> = new Map(
    definedIdentifiers.values().map((identifier) => [identifier, 0]),
  );
  const dependencyOf: Map<string, Set<string>> = new Map(
    definedIdentifiers.values().map((identifier) => [identifier, new Set()]),
  );

  for (const [identifier, decl] of definedDeclElements) {
    const dependencies = findNeighborDecls(decl, definedIdentifiers);
    dependenciesLeft.set(identifier, dependencies.size);

    for (const neighbor of dependencies) {
      dependencyOf.get(neighbor)?.add(identifier);
    }
  }

  const queue: Queue<string> = new Queue(
    dependenciesLeft
      .entries()
      .filter(([, dependencies]) => dependencies === 0)
      .map(([key]) => key)
      .toArray(),
  );
  const visited = new Set();
  const orderedDecls: TypeDeclElem[] = [];

  while (queue.length > 0) {
    const current = queue.remove() as string;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    orderedDecls.push(definedDeclElements.get(current) as TypeDeclElem);

    for (const neighbor of dependencyOf.get(current) ?? []) {
      const count = dependenciesLeft.get(neighbor) as number;
      dependenciesLeft.set(neighbor, count - 1);
      if (count === 1) {
        queue.add(neighbor);
      }
    }
  }

  if (visited.size !== definedIdentifiers.size) {
    throw new Error(
      'Cyclic dependency in struct member or alias types detected!',
    );
  }

  return orderedDecls;
}

function findNeighborDecls(
  decl: TypeDeclElem,
  relevantIdentifiers: Set<string>,
): Set<string> {
  const neighbors: Set<string> = new Set();

  function findTypeReferences(type: TypeRefElem) {
    const name = type.name.originalName;
    if (relevantIdentifiers.has(name)) {
      neighbors.add(name);
    }
    for (const elem of type.templateParams ?? []) {
      const subtype = asTypeRef(elem);
      if (subtype) {
        findTypeReferences(subtype);
      }
    }
  }

  for (const typeRef of typeRefsOf(decl)) {
    findTypeReferences(typeRef);
  }
  return neighbors;
}

/**
 * Emits `alias Name = T;` as `export const Name = <T>;`.
 * An alias of a runtime-sized array becomes a function of the array length,
 * `export const Name = (__arrayLength => d.arrayOf(T, __arrayLength));`,
 * mirroring how runtime-sized structs are emitted.
 */
export function generateAlias(
  alias: AliasElem,
  nonTgpuIdentifiers: Set<string>,
): string {
  const name = declName(alias);
  const src = alias.name.srcModule.src;
  let type = generateType(alias.typeRef, nonTgpuIdentifiers, src);
  // An alias of another runtime-sized alias is already a function, so it's exported as is.
  if (isRuntimeSizedArray(alias.typeRef)) {
    type = `(${VariableSizedArrayParam} => ${type})`;
  }
  return `export const ${name} = ${type};`;
}

export function generateStruct(
  struct: StructElem,
  nonTgpuIdentifiers: Set<string>,
  runtimeSizedAliases: Set<string> = new Set(),
): string {
  const name = declName(struct);
  const src = struct.name.srcModule.src;
  const fieldsCode = genObjectFromRawEntries(
    struct.members.map((member) =>
      generateMember(member, nonTgpuIdentifiers, runtimeSizedAliases, src),
    ),
  );
  let structDefinition = wrapInAttributes(
    `d.struct(${fieldsCode}).$name(${genString(name)})`,
    struct.attributes,
    src,
  );
  if (isVariableLength(struct, runtimeSizedAliases)) {
    structDefinition = `(${VariableSizedArrayParam} => ${structDefinition})`;
  }
  return `export const ${name} = ${structDefinition};`;
}

function generateMember(
  member: StructMemberElem,
  nonTgpuIdentifiers: Set<string>,
  runtimeSizedAliases: Set<string>,
  src: string,
): [string, string] {
  let type = generateType(member.typeRef, nonTgpuIdentifiers, src);
  // Runtime-sized aliases are functions of the array length, so we pass it on.
  if (runtimeSizedAliases.has(member.typeRef.name.originalName)) {
    type = `${type}(${VariableSizedArrayParam})`;
  }
  return [member.name.name, wrapInAttributes(type, member.attributes, src)];
}

function isVariableLength(
  struct: StructElem,
  runtimeSizedAliases: Set<string>,
): boolean {
  const lastMember = struct.members.at(-1);
  return (
    !!lastMember && isRuntimeSized(lastMember.typeRef, runtimeSizedAliases)
  );
}

/** Whether the type is a runtime-sized array, either directly or through a local alias. */
function isRuntimeSized(
  typeRef: TypeRefElem,
  runtimeSizedAliases: Set<string>,
): boolean {
  return (
    isRuntimeSizedArray(typeRef) ||
    runtimeSizedAliases.has(typeRef.name.originalName)
  );
}

function isRuntimeSizedArray(typeRef: TypeRefElem): boolean {
  return (
    typeRef.name.originalName === 'array' &&
    !!typeRef.templateParams &&
    typeRef.templateParams.length === 1
  );
}

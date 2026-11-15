import { genObjectFromRawEntries, genString } from 'knitwork';
import type {
  AliasElem,
  StructElem,
  StructMemberElem,
  TypeRefElem,
} from 'wesl';

import {
  ModuleTranslationError,
  TranslationError,
  TypeDeclTranslationError,
  formatLocation,
  locate,
  quoteSource,
} from './errors.ts';
import type { ExpressionContext } from './expressions.ts';
import { importBinding } from './imports.ts';
import { exportBinding, lazyExportBinding, lazyGetterName } from './names.ts';
import { Queue } from './queue.ts';
import { asTypeRef, generateType, wrapInAttributes } from './types.ts';

/** A module-level declaration that is emitted as an exported TypeGPU schema. */
export type TypeDeclElem = StructElem | AliasElem;

export interface TypeDeclSnippets {
  /** Code for the emitted declarations, in dependency order. */
  snippets: string[];
  /** Declarations that were translated successfully. */
  translated: TypeDeclElem[];
  /** Errors of the declarations that could not be translated, which are emitted as throwing placeholders. */
  errors: TypeDeclTranslationError[];
}

/**
 * Name of the helper emitted into modules with declarations that cannot be translated.
 * WGSL identifiers cannot contain `$` and inlined imports (`a$b$C`) never start with it, so this cannot collide.
 */
const UntranslatableHelper = '$untranslatable';

/**
 * A broken declaration is exported as a callable Proxy whose every trap throws the located error,
 * so importing it is fine (the rest of the module stays usable), but using it in any way fails loudly.
 */
const untranslatableProxy = `new Proxy(function () {}, Object.fromEntries(['get', 'set', 'has', 'apply', 'construct', 'ownKeys', 'getOwnPropertyDescriptor', 'defineProperty', 'deleteProperty', 'getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions'].map((trap) => [trap, () => { throw new Error(message); }])))`;
const untranslatableHelperSnippet = `const ${UntranslatableHelper} = (message) => ${untranslatableProxy};`;
/** Hoisted, so that lazy getters can use it before the module is evaluated. */
const lazyUntranslatableHelperSnippet = `function ${UntranslatableHelper}(message) { return ${untranslatableProxy}; }`;

/**
 * @param lazyImports set when the module is part of an import cycle (see `findModuleCycle`).
 *   Every declaration is then emitted behind a hoisted getter (see `lazyExportBinding`), and the
 *   imported names in this set (declarations of other modules in the cycle) are read through theirs.
 */
export function generateStructSnippets(
  declElems: TypeDeclElem[],
  importsNamespace: Set<string>,
  ctx: ExpressionContext,
  lazyImports?: Set<string>,
): TypeDeclSnippets {
  const sortedDecls = sortDecls(declElems);
  const declNames = new Set(sortedDecls.map(declName));

  // We need to know which type identifiers are in typegpu/std and need to be prepended with the `typegpu/data` namespace.
  // Our approach is to find all type identifiers in the namespace introduced by imports, defined structs
  // and defined aliases, and to prepend everything else (that is not an inlined import) with it.
  const nonTgpuIdentifiers: Set<string> = declNames.union(importsNamespace);

  // Aliases of runtime-sized arrays, e.g. `alias Arr = array<f32>;`.
  // They are emitted as functions of the array length, just like runtime-sized structs.
  // Filled in dependency order, so aliases of aliases are detected as well.
  const runtimeSizedAliases = new Set<string>();

  const snippets: string[] = [];
  const translated: TypeDeclElem[] = [];
  const errorOf = new Map<string, TypeDeclTranslationError>();

  function bind(decl: TypeDeclElem, code: string, dependencies = true) {
    const name = declName(decl);
    if (!lazyImports) {
      return exportBinding(ctx.names, name, code);
    }
    const used = dependencies ? declTypeNames(decl) : new Set<string>();
    return lazyExportBinding(
      ctx.names,
      name,
      [
        ...[...used.intersection(declNames)].map((dep): [string, string] => [
          ctx.names.local(dep),
          lazyGetterName(dep),
        ]),
        ...[...used.intersection(lazyImports)].map((dep): [string, string] => {
          const binding = importBinding(dep, ctx.names);
          return [binding, lazyGetterName(binding)];
        }),
      ],
      code,
    );
  }

  for (const decl of sortedDecls) {
    const name = declName(decl);
    let error = findBrokenDependency(decl, declNames, errorOf);
    if (!error) {
      try {
        if (decl.kind === 'alias') {
          if (isRuntimeSized(decl.typeRef, runtimeSizedAliases)) {
            runtimeSizedAliases.add(name);
          }
          snippets.push(
            bind(decl, generateAlias(decl, nonTgpuIdentifiers, ctx)),
          );
        } else {
          snippets.push(
            bind(
              decl,
              generateStruct(
                decl,
                nonTgpuIdentifiers,
                ctx,
                runtimeSizedAliases,
              ),
            ),
          );
        }
        translated.push(decl);
        continue;
      } catch (e) {
        error = toDeclError(e, decl);
      }
    }
    errorOf.set(name, error);
    snippets.push(
      bind(
        decl,
        `/* @__PURE__ */ ${UntranslatableHelper}(${genString(error.message)})`,
        false,
      ),
    );
  }

  if (errorOf.size > 0) {
    snippets.unshift(
      lazyImports
        ? lazyUntranslatableHelperSnippet
        : untranslatableHelperSnippet,
    );
  }

  return { snippets, translated, errors: [...errorOf.values()] };
}

/**
 * Returns an error if `decl` uses another declaration of the module that could not be translated,
 * pointing at the member that uses it and at the root cause.
 */
function findBrokenDependency(
  decl: TypeDeclElem,
  declNames: Set<string>,
  errorOf: Map<string, TypeDeclTranslationError>,
): TypeDeclTranslationError | undefined {
  const uses: [TypeRefElem, StructMemberElem | undefined][] =
    decl.kind === 'alias'
      ? [[decl.typeRef, undefined]]
      : decl.members.map((member) => [member.typeRef, member]);

  for (const [typeRef, member] of uses) {
    for (const dependency of findReferencedDecls(typeRef, declNames)) {
      const dependencyError = errorOf.get(dependency);
      if (dependencyError) {
        return new TypeDeclTranslationError({
          decl,
          memberName: member?.name.name,
          span: typeRef,
          reason: `depends on '${dependency}', which cannot be translated. Root cause: ${rootCauseOf(dependencyError).message}`,
          rootDeclName: dependencyError.rootDeclName,
          cause: dependencyError,
        });
      }
    }
  }
  return undefined;
}

function rootCauseOf(
  error: TypeDeclTranslationError,
): TypeDeclTranslationError {
  let current = error;
  while (current.cause instanceof TypeDeclTranslationError) {
    current = current.cause;
  }
  return current;
}

function toDeclError(
  error: unknown,
  decl: TypeDeclElem,
): TypeDeclTranslationError {
  const memberError = error instanceof MemberError ? error : undefined;
  const cause = memberError ? memberError.cause : error;
  const member = memberError?.member;
  const src = decl.name.srcModule.src;
  const span =
    (cause instanceof TranslationError ? cause.span : undefined) ??
    member ??
    decl.name;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new TypeDeclTranslationError({
    decl,
    memberName: member?.name.name,
    span,
    reason: `${message}${quoteSource(src, span)}`,
    cause,
  });
}

/** Marks which member a translation error came from. */
class MemberError extends Error {
  readonly member: StructMemberElem;

  constructor(member: StructMemberElem, cause: unknown) {
    super('Member translation failed', { cause });
    this.member = member;
  }
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
  const dependenciesOf: Map<string, Set<string>> = new Map();
  const dependencyOf: Map<string, Set<string>> = new Map(
    definedIdentifiers.values().map((identifier) => [identifier, new Set()]),
  );

  for (const [identifier, decl] of definedDeclElements) {
    const dependencies = findNeighborDecls(decl, definedIdentifiers);
    dependenciesOf.set(identifier, dependencies);
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
  const visited = new Set<string>();
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
    const cycle = findCycle(definedIdentifiers, visited, dependenciesOf);
    const first = definedDeclElements.get(cycle[0]) as TypeDeclElem;
    throw new ModuleTranslationError(
      `${formatLocation(locate(first, first.start))}: Cyclic dependency between types: ${[...cycle, cycle[0]].join(' -> ')}`,
    );
  }

  return orderedDecls;
}

/**
 * Every declaration left unvisited by the topological sort depends on at least one other unvisited one,
 * so following those dependencies from any of them must eventually loop.
 */
function findCycle(
  identifiers: Set<string>,
  visited: Set<string>,
  dependenciesOf: Map<string, Set<string>>,
): string[] {
  const path: string[] = [];
  let current = [...identifiers].find((id) => !visited.has(id)) as string;
  while (!path.includes(current)) {
    path.push(current);
    current = [...(dependenciesOf.get(current) ?? [])].find(
      (dependency) => !visited.has(dependency),
    ) as string;
  }
  return path.slice(path.indexOf(current));
}

function findNeighborDecls(
  decl: TypeDeclElem,
  relevantIdentifiers: Set<string>,
): Set<string> {
  const neighbors: Set<string> = new Set();
  for (const typeRef of typeRefsOf(decl)) {
    findReferencedDecls(typeRef, relevantIdentifiers, neighbors);
  }
  return neighbors;
}

/**
 * Names of all types a declaration references, including template parameters,
 * e.g. `array<package::file::Struct, 4>` gives `array` and `package::file::Struct`.
 */
export function declTypeNames(decl: TypeDeclElem): Set<string> {
  const names = new Set<string>();
  function visit(type: TypeRefElem) {
    names.add(type.name.originalName);
    for (const elem of type.templateParams ?? []) {
      const subtype = asTypeRef(elem);
      if (subtype) {
        visit(subtype);
      }
    }
  }
  for (const typeRef of typeRefsOf(decl)) {
    visit(typeRef);
  }
  return names;
}

function findReferencedDecls(
  type: TypeRefElem,
  relevantIdentifiers: Set<string>,
  found: Set<string> = new Set(),
): Set<string> {
  const name = type.name.originalName;
  if (relevantIdentifiers.has(name)) {
    found.add(name);
  }
  for (const elem of type.templateParams ?? []) {
    const subtype = asTypeRef(elem);
    if (subtype) {
      findReferencedDecls(subtype, relevantIdentifiers, found);
    }
  }
  return found;
}

/**
 * Translates `alias Name = T;` into the code for `<T>`, which is exported as `Name`.
 * An alias of a runtime-sized array becomes a function of the array length,
 * `(__arrayLength => d.arrayOf(T, __arrayLength))`,
 * mirroring how runtime-sized structs are emitted.
 */
export function generateAlias(
  alias: AliasElem,
  nonTgpuIdentifiers: Set<string>,
  ctx: ExpressionContext,
): string {
  let type = generateType(alias.typeRef, nonTgpuIdentifiers, ctx);
  // An alias of another runtime-sized alias is already a function, so it's exported as is.
  if (isRuntimeSizedArray(alias.typeRef)) {
    type = `(${ctx.names.arrayLength} => ${type})`;
  }
  return type;
}

export function generateStruct(
  struct: StructElem,
  nonTgpuIdentifiers: Set<string>,
  ctx: ExpressionContext,
  runtimeSizedAliases: Set<string> = new Set(),
): string {
  const name = declName(struct);
  const fieldsCode = genObjectFromRawEntries(
    struct.members.map((member) =>
      generateMember(member, nonTgpuIdentifiers, runtimeSizedAliases, ctx),
    ),
  );
  let structDefinition = wrapInAttributes(
    `${ctx.names.data}.struct(${fieldsCode}).$name(${genString(name)})`,
    struct.attributes,
    ctx,
  );
  if (isVariableLength(struct, runtimeSizedAliases)) {
    structDefinition = `(${ctx.names.arrayLength} => ${structDefinition})`;
  }
  return structDefinition;
}

function generateMember(
  member: StructMemberElem,
  nonTgpuIdentifiers: Set<string>,
  runtimeSizedAliases: Set<string>,
  ctx: ExpressionContext,
): [string, string] {
  try {
    let type = generateType(member.typeRef, nonTgpuIdentifiers, ctx);
    // Runtime-sized aliases are functions of the array length, so we pass it on.
    if (runtimeSizedAliases.has(member.typeRef.name.originalName)) {
      type = `${type}(${ctx.names.arrayLength})`;
    }
    return [member.name.name, wrapInAttributes(type, member.attributes, ctx)];
  } catch (error) {
    throw new MemberError(member, error);
  }
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

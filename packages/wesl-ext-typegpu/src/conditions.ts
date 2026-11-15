import {
  type AliasElem,
  type ConstElem,
  type ImportElem,
  type ModuleElem,
  type StructElem,
  filterValidElements,
} from 'wesl';

/** Conditions for `@if`/`@elif`/`@else`, as wesl-plugin parses them from the import query */
export type Conditions = Record<string, boolean>;

export interface ModuleDecls {
  imports: ImportElem[];
  structs: StructElem[];
  aliases: AliasElem[];
  consts: ConstElem[];
}

/**
 * Returns the top-level declarations of a module that are valid under `conditions`, with struct members
 * filtered the same way. Like in the linker, an unset condition is false.
 *
 * Conditional compilation is resolved up front, so that omitted declarations and members don't pull in
 * imports, create dependencies, or fail to translate. Top-level declarations are filtered together,
 * since an `@if`/`@elif`/`@else` chain spans consecutive siblings regardless of their kind.
 */
export function validDecls(
  moduleElem: ModuleElem,
  conditions: Conditions,
): ModuleDecls {
  const decls = filterValidElements(moduleElem.decls, conditions);
  return {
    imports: decls.filter((decl) => decl.kind === 'import'),
    structs: decls
      .filter((decl) => decl.kind === 'struct')
      .map((struct) => ({
        ...struct,
        members: filterValidElements(struct.members, conditions),
      })),
    aliases: decls.filter((decl) => decl.kind === 'alias'),
    consts: decls.filter((decl) => decl.kind === 'const'),
  };
}

/**
 * The conditions of the emitted module are forwarded to the modules it imports, so that the whole
 * module graph is emitted under the same conditions, like the linker does.
 * Only conditions set to true are forwarded, in sorted order, since an unset condition is false.
 * That way, equivalent sets of conditions map to the same bundler module id.
 */
export function conditionsQuery(conditions: Conditions): string {
  return Object.entries(conditions)
    .filter(([, value]) => value)
    .map(([name]) => name)
    .sort()
    .map((name) => `&${name}`)
    .join('');
}

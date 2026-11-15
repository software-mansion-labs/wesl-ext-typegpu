/**
 * Words that cannot be used as a binding name in an ES module (which is always strict mode code).
 * Most of them are also reserved in WGSL, but e.g. `in`, `function`, `private`, `void`, `eval` and
 * `arguments` are valid WGSL identifiers, so we keep the full list instead of relying on that overlap.
 */
const jsReservedBindings = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/**
 * Names of the JS bindings in the emitted module.
 */
export interface EmitNames {
  /** Local name of the `typegpu/data` namespace import, `d` unless that is taken. */
  data: string;
  /** Parameter name of the length of a runtime-sized array, `__arrayLength` unless that is taken. */
  arrayLength: string;
  /** Local JS binding for a WESL identifier (declaration name or import alias). */
  local(identifier: string): string;
}

/**
 * Picks the generated names so that they don't collide with any of `identifiers`,
 * and renames identifiers that are not valid JS bindings (e.g. `in` → `in_`).
 *
 * Inlined imports (`a::b::C`) are emitted as `a$b$C`. WGSL identifiers can't contain `$`
 * and none of the generated names do, so those never collide and don't need to be passed in.
 */
export function createEmitNames(identifiers: Iterable<string>): EmitNames {
  const identifierSet = new Set(identifiers);
  const taken = new Set(
    [...identifierSet].filter((name) => !jsReservedBindings.has(name)),
  );

  function claim(base: string): string {
    let name = base;
    for (let i = 1; taken.has(name) || jsReservedBindings.has(name); i++) {
      name = `${base}_${i}`;
    }
    taken.add(name);
    return name;
  }

  const data = claim('d');
  const arrayLength = claim('__arrayLength');

  const renamed = new Map<string, string>();
  for (const name of identifierSet) {
    if (jsReservedBindings.has(name)) {
      renamed.set(name, claim(`${name}_`));
    }
  }

  return {
    data,
    arrayLength,
    local: (identifier) => renamed.get(identifier) ?? identifier,
  };
}

/**
 * Emits `export const name = code;`. Names that are not valid JS bindings (e.g. `in`)
 * are still valid export names, so those are declared under their local name and re-exported.
 */
export function exportBinding(
  names: EmitNames,
  name: string,
  code: string,
): string {
  const localName = names.local(name);
  if (localName === name) {
    return `export const ${name} = ${code};`;
  }
  return `const ${localName} = ${code};\nexport { ${localName} as ${name} };`;
}

/**
 * Name of the hoisted getter emitted for each declaration of a module that is part of an import cycle
 * (see `findModuleCycle`). WGSL identifiers can't contain `$` and inlined imports (`a$b$C`) never start
 * with it, so this can't collide.
 */
export function lazyGetterName(name: string): string {
  return `$get$${name}`;
}

/**
 * Lazy counterpart of {@link exportBinding}, e.g.
 * ```js
 * export function $get$A() {
 *   const B = $get$B();
 *   return A ??= d.struct({ b: B }).$name("A");
 * }
 * export var A = $get$A();
 * ```
 * Function declarations and `var` bindings exist as soon as the module is linked, so another module
 * of the cycle can call the getter before this module is evaluated. The value is still created once.
 *
 * @param dependencies bindings used by `code`, each paired with the getter that provides it
 */
export function lazyExportBinding(
  names: EmitNames,
  name: string,
  dependencies: [binding: string, getter: string][],
  code: string,
): string {
  const localName = names.local(name);
  const getter = lazyGetterName(name);
  return [
    `export function ${getter}() {`,
    ...dependencies.map(
      ([binding, dependencyGetter]) =>
        `  const ${binding} = ${dependencyGetter}();`,
    ),
    `  return ${localName} ??= ${code};`,
    `}`,
    localName === name
      ? `export var ${name} = ${getter}();`
      : `var ${localName} = ${getter}();\nexport { ${localName} as ${name} };`,
  ].join('\n');
}

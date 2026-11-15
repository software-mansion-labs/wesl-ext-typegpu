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

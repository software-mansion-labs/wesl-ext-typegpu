import { genString } from 'knitwork';

import {
  type ExpressionContext,
  type TypedValue,
  UntranslatableExpressionError,
  resolveTypeRef,
  translateValue,
} from './expressions.ts';
import { importBinding } from './imports.ts';
import {
  type EmitNames,
  createEmitNames,
  exportBinding,
  lazyExportBinding,
  lazyGetterName,
} from './names.ts';
import {
  type ModuleGraph,
  type ModuleScope,
  importedDeclOf,
  modulePathOf,
  resolveImportedDecl,
} from './scope.ts';
import {
  type StructType,
  type ValueType,
  concretize,
  convertValue,
  schemaOf,
  unknownType,
} from './valueTypes.ts';

type ConstTranslation =
  | {
      ok: true;
      /** The declared type, which can be abstract (e.g. `AbstractInt` for `const N = 4;`) */
      type: ValueType;
      /** The `tgpu.const(...)` call. */
      code: string;
      /** Structs of the module that the const (transitively) uses. */
      localTypes: Set<string>;
      /** Imported names that the code refers to. */
      references: Set<string>;
    }
  | { ok: false; reason: string };

/** What the const being translated uses, see {@link ConstTranslation}. */
interface Frame {
  localTypes: Set<string>;
  references: Set<string>;
}

interface TranslatorOptions {
  names: EmitNames;
  /** See {@link translateConsts} */
  lazy: boolean;
  /** Imported names that have to be read through their lazy getters, see `findModuleCycle`. */
  lazyImports: Set<string>;
  /** Paths of the modules in an import cycle with this one, see `findModuleCycle`. */
  cycleModules: Set<string>;
}

/**
 * Translates the consts of a module. Consts of other modules are translated as well (and their code thrown away),
 * since the types of consts and structs a const refers to decide what it's translated into.
 */
class ModuleConsts {
  readonly ctx: ExpressionContext;
  /** Names of the translated consts, in the order they were translated, so that dependencies come first. */
  readonly order: string[] = [];
  readonly #translations = new Map<string, ConstTranslation>();
  readonly #inProgress = new Set<string>();
  readonly #aliasesInProgress = new Set<string>();
  readonly #frames: Frame[] = [];
  /**
   * Imported names that weren't written in the module, but have to be read through their lazy getters,
   * e.g. a struct of another module in the cycle that is the type of an imported const.
   */
  readonly extraLazyImports = new Set<string>();

  readonly scope: ModuleScope;
  readonly modules: ModuleConstsRegistry;
  readonly options: TranslatorOptions;

  constructor(
    scope: ModuleScope,
    modules: ModuleConstsRegistry,
    options: TranslatorOptions,
  ) {
    this.scope = scope;
    this.modules = modules;
    this.options = options;
    const { names, lazy, lazyImports } = options;
    const record = (fn: (frame: Frame) => void) => {
      const frame = this.#frames.at(-1);
      if (frame) {
        fn(frame);
      }
    };

    const ctx: ExpressionContext = {
      names,
      data: names.data,
      module: scope.path,

      resolveValue: (name) => {
        if (!name.includes('::') && scope.consts.has(name)) {
          const translation = this.translate(name);
          if (!translation.ok) {
            throw new UntranslatableExpressionError(
              `const '${name}' cannot be translated: ${translation.reason}`,
            );
          }
          const frame = this.#frames.at(-1);
          if (frame) {
            for (const type of translation.localTypes) {
              frame.localTypes.add(type);
            }
          } else if (!lazy && translation.localTypes.size > 0) {
            // Consts that use structs are emitted after them, so the structs can't use them in turn.
            throw new UntranslatableExpressionError(
              `const '${name}' is created from a struct, so it cannot be used in a type`,
            );
          }
          const binding = lazy
            ? `${lazyGetterName(name)}()`
            : names.local(name);
          return this.#reference(`${binding}.$`, translation.type);
        }

        const decl = resolveImportedDecl(scope, name);
        if (decl) {
          record((frame) => frame.references.add(name));
          const binding = importBinding(name, names);
          return this.#reference(
            lazyImports.has(name)
              ? `${lazyGetterName(binding)}().$`
              : `${binding}.$`,
            this.modules.constType(decl.module, decl.name),
          );
        }

        throw new UntranslatableExpressionError(
          `'${name}' does not refer to a const`,
        );
      },

      resolveNamedType: (name) => {
        if (!name.includes('::')) {
          if (scope.structs.has(name)) {
            return { kind: 'struct', module: scope.path, name };
          }
          if (scope.aliases.has(name)) {
            return this.resolveAlias(name);
          }
        }
        const decl = resolveImportedDecl(scope, name);
        if (!decl) {
          return undefined;
        }
        const module = this.modules.get(decl.module);
        if (!module) {
          throw new UntranslatableExpressionError(
            `cannot find module '${decl.module}' to resolve '${name}'`,
          );
        }
        if (module.scope.structs.has(decl.name)) {
          return { kind: 'struct', module: decl.module, name: decl.name };
        }
        if (module.scope.aliases.has(decl.name)) {
          return module.resolveAlias(decl.name);
        }
        return undefined;
      },

      structSchema: (type) => this.#structSchema(type, record),

      structMembers: (type) => this.modules.structMembers(type),
    };
    this.ctx = ctx;
  }

  translate(name: string): ConstTranslation {
    const existing = this.#translations.get(name);
    if (existing) {
      return existing;
    }
    if (this.#inProgress.has(name)) {
      return { ok: false, reason: 'it depends on itself' };
    }
    const elem = this.scope.consts.get(name);
    if (!elem) {
      return { ok: false, reason: `there is no const '${name}'` };
    }

    this.#inProgress.add(name);
    const frame: Frame = { localTypes: new Set(), references: new Set() };
    this.#frames.push(frame);
    let translation: ConstTranslation;
    try {
      if (!elem.init) {
        throw new UntranslatableExpressionError('it has no initializer');
      }
      const value = translateValue(elem.init, this.ctx);
      const type = elem.name.typeRef
        ? resolveTypeRef(elem.name.typeRef, this.ctx)
        : value.type;
      const concreteType = concretize(type);
      const schema = schemaOf(concreteType, this.ctx);
      const valueCode = value.emit(concreteType);
      translation = {
        ok: true,
        type,
        code: `${this.options.names.tgpu}.const(${schema}, ${valueCode}).$name(${genString(name)})`,
        ...frame,
      };
    } catch (error) {
      if (!(error instanceof UntranslatableExpressionError)) {
        throw error;
      }
      translation = { ok: false, reason: error.message };
    } finally {
      this.#frames.pop();
      this.#inProgress.delete(name);
    }

    this.#translations.set(name, translation);
    if (translation.ok) {
      this.order.push(name);
    }
    return translation;
  }

  resolveAlias(name: string): ValueType {
    const alias = this.scope.aliases.get(name);
    if (!alias || this.#aliasesInProgress.has(name)) {
      throw new UntranslatableExpressionError(`cannot resolve alias '${name}'`);
    }
    this.#aliasesInProgress.add(name);
    try {
      return resolveTypeRef(alias.typeRef, this.ctx);
    } finally {
      this.#aliasesInProgress.delete(name);
    }
  }

  /** A value read from a const, which holds a value of the concretized type. */
  #reference(code: string, type: ValueType): TypedValue {
    return {
      type,
      emit: (target) => convertValue(code, concretize(type), target, this.ctx),
    };
  }

  #structSchema(
    type: StructType,
    record: (fn: (frame: Frame) => void) => void,
  ): string {
    const { names, lazy, lazyImports, cycleModules } = this.options;
    const getterIfLazy = (written: string, binding: string) => {
      if (lazy && cycleModules.has(type.module)) {
        this.extraLazyImports.add(written);
      }
      return lazyImports.has(written) || this.extraLazyImports.has(written)
        ? `${lazyGetterName(binding)}()`
        : binding;
    };
    if (type.module === this.scope.path) {
      record((frame) => frame.localTypes.add(type.name));
      return lazy ? `${lazyGetterName(type.name)}()` : names.local(type.name);
    }
    // Prefer the name the struct is imported as, or a path through its imported module.
    for (const [alias, resolved] of this.scope.importOfAlias) {
      const decl = importedDeclOf(resolved);
      const written =
        decl.module === type.module && decl.name === type.name
          ? alias
          : modulePathOf(resolved) === type.module
            ? `${alias}::${type.name}`
            : undefined;
      if (written) {
        record((frame) => frame.references.add(written));
        return getterIfLazy(written, importBinding(written, names));
      }
    }
    // Otherwise, e.g. for the type of a const imported from another module, it's imported by its full path.
    const path = `${type.module}::${type.name}`;
    record((frame) => frame.references.add(path));
    return getterIfLazy(path, importBinding(path, names));
  }
}

/** The translators of all modules that consts refer to. */
class ModuleConstsRegistry {
  readonly #modules = new Map<string, ModuleConsts | undefined>();

  readonly graph: ModuleGraph;

  constructor(graph: ModuleGraph) {
    this.graph = graph;
  }

  add(module: ModuleConsts): void {
    this.#modules.set(module.scope.path, module);
  }

  get(path: string): ModuleConsts | undefined {
    if (!this.#modules.has(path)) {
      const scope = this.graph.scope(path);
      this.#modules.set(
        path,
        scope &&
          new ModuleConsts(scope, this, {
            names: createEmitNames([]),
            lazy: false,
            lazyImports: new Set(),
            cycleModules: new Set(),
          }),
      );
    }
    return this.#modules.get(path);
  }

  /**
   * The type of a const of another module. Throws if the const exists but cannot be translated,
   * since it isn't exported then.
   */
  constType(module: string, name: string): ValueType {
    const consts = this.get(module);
    if (!consts?.scope.consts.has(name)) {
      return unknownType;
    }
    const translation = consts.translate(name);
    if (!translation.ok) {
      throw new UntranslatableExpressionError(
        `const '${name}' of module '${module}' cannot be translated: ${translation.reason}`,
      );
    }
    return translation.type;
  }

  structMembers(type: StructType): [string, ValueType][] | undefined {
    const consts = this.get(type.module);
    const struct = consts?.scope.structs.get(type.name);
    if (!consts || !struct) {
      return undefined;
    }
    return struct.members.map((member) => {
      let memberType: ValueType;
      try {
        memberType = resolveTypeRef(member.typeRef, consts.ctx);
      } catch {
        memberType = unknownType;
      }
      return [member.name.name, memberType];
    });
  }
}

export interface TranslatedConsts {
  /** Context for translating expressions that may reference consts and imports of this module. */
  ctx: ExpressionContext;
  /**
   * Emits the translated consts, skipping the ones that use a struct that could not be translated.
   * Every const is exported as a `tgpu.const`, so that other modules can import it.
   */
  emit(brokenTypes: Set<string>): {
    /** `export const ...` snippets of consts that don't use structs, ordered so that dependencies come first. */
    early: string[];
    /** Snippets of consts that use structs of the module, to be emitted after them. */
    late: string[];
    /** Imported names referenced by the emitted consts. */
    referencedIdentifiers: Set<string>;
    /** Imported names that have to be read through their lazy getters, in addition to the ones of the cycle. */
    lazyImports: Set<string>;
  };
}

/**
 * Translates the module-level consts into `tgpu.const` declarations.
 *
 * Consts that cannot be translated (e.g. `const v = max(1, 2);`) are skipped, unless an expression
 * we do need to emit references them, in which case `ctx.resolveValue` throws.
 *
 * @param cycle set for modules in an import cycle (see `findModuleCycle`). Their declarations can be
 *   created before the module is evaluated, so references to consts and structs go through hoisted getters instead.
 */
export function translateConsts(
  scope: ModuleScope,
  graph: ModuleGraph,
  names: EmitNames,
  cycle?: { lazyImports: Set<string>; modules: Set<string> },
): TranslatedConsts {
  const registry = new ModuleConstsRegistry(graph);
  const lazy = cycle !== undefined;
  const module = new ModuleConsts(scope, registry, {
    names,
    lazy,
    lazyImports: cycle?.lazyImports ?? new Set(),
    cycleModules: cycle?.modules ?? new Set(),
  });
  registry.add(module);

  for (const name of scope.consts.keys()) {
    module.translate(name);
  }

  return {
    ctx: module.ctx,
    emit(brokenTypes) {
      const early: string[] = [];
      const late: string[] = [];
      const referencedIdentifiers = new Set<string>();
      for (const name of module.order) {
        const translation = module.translate(name);
        if (
          !translation.ok ||
          !translation.localTypes.isDisjointFrom(brokenTypes)
        ) {
          continue;
        }
        const snippet = lazy
          ? lazyExportBinding(names, name, [], translation.code)
          : exportBinding(names, name, translation.code);
        (translation.localTypes.size > 0 ? late : early).push(snippet);
        for (const reference of translation.references) {
          referencedIdentifiers.add(reference);
        }
      }
      return {
        early,
        late,
        referencedIdentifiers,
        lazyImports: module.extraLazyImports,
      };
    },
  };
}

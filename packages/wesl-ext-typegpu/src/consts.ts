import type { ConstElem } from 'wesl';

import {
  type ExpressionContext,
  UntranslatableExpressionError,
  forEachReferencedIdentifier,
  translateExpression,
} from './expressions.ts';
import { type EmitNames, exportBinding } from './names.ts';

type ConstTranslation =
  | { ok: true; code: string }
  | { ok: false; reason: string };

export interface TranslatedConsts {
  /** `export const ...` snippets, ordered so that dependencies come first. */
  snippets: string[];
  /** Identifiers referenced by the emitted consts. */
  referencedIdentifiers: Set<string>;
  /** Context for translating expressions that may reference consts and imports of this module. */
  ctx: ExpressionContext;
}

/**
 * Translates the module-level consts into JS.
 *
 * Every const that can be translated is exported, so that other modules can import it.
 * Consts that cannot be translated (e.g. `const v = vec3f(1);`) are skipped, unless an expression
 * we do need to emit references them, in which case `ctx.resolveIdentifier` throws.
 */
export function translateConsts(
  constElems: ConstElem[],
  importsNamespace: Set<string>,
  names: EmitNames,
): TranslatedConsts {
  const constByName = new Map(
    constElems.map((elem) => [elem.name.decl.ident.originalName, elem]),
  );
  const translations = new Map<string, ConstTranslation>();
  const inProgress = new Set<string>();
  const snippets: string[] = [];
  const referencedIdentifiers = new Set<string>();

  const ctx: ExpressionContext = {
    resolveIdentifier(name) {
      if (name.includes('::')) {
        return name.replaceAll('::', '$');
      }
      if (constByName.has(name)) {
        const translation = translate(name);
        if (!translation.ok) {
          throw new UntranslatableExpressionError(
            `const '${name}' cannot be translated: ${translation.reason}`,
          );
        }
        return names.local(name);
      }
      if (importsNamespace.has(name)) {
        return names.local(name);
      }
      throw new UntranslatableExpressionError(
        `'${name}' does not refer to a const`,
      );
    },
    names,
  };

  function translate(name: string): ConstTranslation {
    const existing = translations.get(name);
    if (existing) {
      return existing;
    }
    if (inProgress.has(name)) {
      return { ok: false, reason: 'it depends on itself' };
    }
    const elem = constByName.get(name) as ConstElem;
    inProgress.add(name);
    let translation: ConstTranslation;
    try {
      if (!elem.init) {
        throw new UntranslatableExpressionError('it has no initializer');
      }
      translation = { ok: true, code: translateExpression(elem.init, ctx) };
    } catch (error) {
      if (!(error instanceof UntranslatableExpressionError)) {
        throw error;
      }
      translation = { ok: false, reason: error.message };
    }
    inProgress.delete(name);
    translations.set(name, translation);

    if (translation.ok) {
      // Dependencies were translated (and pushed) while translating the initializer.
      snippets.push(exportBinding(names, name, translation.code));
      if (elem.init) {
        forEachReferencedIdentifier(elem.init, (ref) =>
          referencedIdentifiers.add(ref),
        );
      }
    }
    return translation;
  }

  for (const name of constByName.keys()) {
    translate(name);
  }

  return { snippets, referencedIdentifiers, ctx };
}

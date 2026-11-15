import type { ExpressionElem, RefIdentElem, TypeRefElem } from 'wesl';

import { type Span, TranslationError } from './errors.ts';
import type { EmitNames } from './names.ts';

/**
 * Thrown when a WGSL expression has no JS equivalent we can emit.
 * `translateExpression` attaches the innermost expression it failed on, and callers add the context
 * (struct, member, const) the expression came from.
 */
export class UntranslatableExpressionError extends TranslationError {
  constructor(message: string, span?: Span) {
    super(message, span);
    this.name = 'UntranslatableExpressionError';
  }
}

export interface ExpressionContext {
  /**
   * Resolves a referenced identifier to the JS identifier it should be emitted as,
   * or throws an `UntranslatableExpressionError` if it cannot be referenced.
   */
  resolveIdentifier(name: string): string;
  /** Names of the JS bindings in the emitted module. */
  names: EmitNames;
}

const binaryOperators = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '<<',
  '>>',
]);

const unaryOperators = new Set(['-', '~']);

/**
 * Translates a WGSL const-expression into an equivalent JS expression.
 *
 * Supports literals, identifiers, parentheses and integer arithmetic, which is what array lengths
 * and attribute arguments can consist of once function calls are excluded.
 * Since such expressions are integer-typed (WGSL has no implicit float -> int conversion),
 * `/` is emitted as truncating integer division.
 */
export function translateExpression(
  expr: ExpressionElem,
  ctx: ExpressionContext,
): string {
  try {
    return translateExpressionUnlocated(expr, ctx);
  } catch (error) {
    if (error instanceof TranslationError && !error.span) {
      error.span = expr;
    }
    throw error;
  }
}

function translateExpressionUnlocated(
  expr: ExpressionElem,
  ctx: ExpressionContext,
): string {
  switch (expr.kind) {
    case 'literal':
      return translateLiteral(expr.value);
    case 'ref':
      return ctx.resolveIdentifier(expr.ident.originalName);
    case 'parenthesized-expression':
      return `(${translateExpression(expr.expression, ctx)})`;
    case 'unary-expression': {
      const op = expr.operator.value;
      if (!unaryOperators.has(op)) {
        throw new UntranslatableExpressionError(
          `unary operator '${op}' is not supported`,
        );
      }
      const operand = translateExpression(expr.expression, ctx);
      // A space keeps `- -x` from turning into the `--` operator.
      return `${op}${operand.startsWith(op) ? ' ' : ''}${operand}`;
    }
    case 'binary-expression': {
      const op = expr.operator.value;
      if (!binaryOperators.has(op)) {
        throw new UntranslatableExpressionError(
          `binary operator '${op}' is not supported`,
        );
      }
      const left = translateExpression(expr.left, ctx);
      const right = translateExpression(expr.right, ctx);
      if (op === '/') {
        return `Math.trunc(${left} / ${right})`;
      }
      return `${left} ${op} ${right}`;
    }
    case 'call-expression':
      throw new UntranslatableExpressionError(
        `function calls ('${calleeName(expr.function)}(...)') are not supported`,
      );
    case 'type':
      throw new UntranslatableExpressionError(
        `type '${expr.name.originalName}' is not a value`,
      );
    case 'component-expression':
    case 'component-member-expression':
      throw new UntranslatableExpressionError(
        'component access is not supported',
      );
  }
}

/** Calls `visit` with the name of every identifier referenced by `expr`. */
export function forEachReferencedIdentifier(
  expr: ExpressionElem,
  visit: (name: string) => void,
): void {
  switch (expr.kind) {
    case 'ref':
      visit(expr.ident.originalName);
      return;
    case 'parenthesized-expression':
    case 'unary-expression':
      forEachReferencedIdentifier(expr.expression, visit);
      return;
    case 'binary-expression':
      forEachReferencedIdentifier(expr.left, visit);
      forEachReferencedIdentifier(expr.right, visit);
      return;
    default:
      // Other expressions are rejected by `translateExpression`.
      return;
  }
}

function calleeName(fn: RefIdentElem | TypeRefElem): string {
  return fn.kind === 'ref' ? fn.ident.originalName : fn.name.originalName;
}

const decimalInt = /^(0|[1-9][0-9]*)[iu]?$/;
const hexInt = /^0[xX][0-9a-fA-F]+[iu]?$/;
const decimalFloat =
  /^(?:(?:[0-9]*\.[0-9]+|[0-9]+\.[0-9]*)(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)[fh]?$|^(?:0|[1-9][0-9]*)[fh]$/;
const hexFloat =
  /^0[xX](?:([0-9a-fA-F]*)\.([0-9a-fA-F]*)(?:[pP]([+-]?[0-9]+)[fh]?)?|([0-9a-fA-F]+)[pP]([+-]?[0-9]+)[fh]?)$/;

/** Translates a WGSL literal (see https://www.w3.org/TR/WGSL/#literals) into a JS literal. */
export function translateLiteral(literal: string): string {
  if (literal === 'true' || literal === 'false') {
    return literal;
  }
  if (decimalInt.test(literal) || hexInt.test(literal)) {
    return literal.replace(/[iu]$/, '');
  }
  if (decimalFloat.test(literal)) {
    return formatNumber(Number(literal.replace(/[fh]$/, '')));
  }
  const hex = hexFloat.exec(literal);
  if (hex) {
    const [, intPart, fracPart, fracExp, wholePart, wholeExp] = hex;
    const mantissaInt = intPart ?? wholePart ?? '';
    const mantissaFrac = fracPart ?? '';
    const exponent = Number(fracExp ?? wholeExp ?? '0');
    const mantissa =
      Number.parseInt(`${mantissaInt}${mantissaFrac}` || '0', 16) /
      16 ** mantissaFrac.length;
    return formatNumber(mantissa * 2 ** exponent);
  }
  throw new UntranslatableExpressionError(`unsupported literal '${literal}'`);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new UntranslatableExpressionError(
      `literal value ${value} is out of range`,
    );
  }
  return String(value);
}

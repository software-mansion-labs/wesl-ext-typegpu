import { genString } from 'knitwork';
import type {
  ExpressionElem,
  FunctionCallExpression,
  RefIdentElem,
  TypeRefElem,
  TypeTemplateParameter,
} from 'wesl';

import { TranslationError, UntranslatableExpressionError } from './errors.ts';
import type { EmitNames } from './names.ts';
import {
  type ScalarType,
  type SchemaContext,
  type StructType,
  type ValueType,
  concretize,
  concretizeScalar,
  convertValue,
  describeType,
  isIntegerScalar,
  scalar,
  scalarTypes,
  schemaOf,
  unify,
} from './valueTypes.ts';

export { UntranslatableExpressionError } from './errors.ts';

/** A translated WGSL value: its type, and a way to emit it as a JS expression. */
export interface TypedValue {
  type: ValueType;
  /**
   * Emits the value as a JS expression. Values of abstract types are emitted as `target`
   * when given (e.g. `vec3(1, 2, 3)` as `d.vec3f(1, 2, 3)` for a `vec3f` const),
   * and as their concretized type otherwise.
   */
  emit(target?: ValueType): string;
}

export interface ExpressionContext extends SchemaContext {
  /** Names of the JS bindings in the emitted module. */
  names: EmitNames;
  /**
   * Resolves an identifier used as a value, or throws an `UntranslatableExpressionError`
   * if it cannot be referenced.
   */
  resolveValue(name: string): TypedValue;
  /**
   * Resolves the name of a struct or alias, as used in a constructor call or a type annotation.
   * Returns undefined if the name doesn't refer to a type.
   */
  resolveNamedType(name: string): ValueType | undefined;
  /** Names and types of the members of a struct, or undefined if they are not known. */
  structMembers(type: StructType): [string, ValueType][] | undefined;
}

/**
 * Template parameters are parsed as expressions. Plain identifiers (e.g. `f32`, `uniform`)
 * come in as references, while templated types (e.g. `array<f32, 4>`) come in as type references.
 * This normalizes both into a type reference, or returns undefined for any other expression.
 */
export function asTypeRef(
  param: TypeTemplateParameter | undefined,
): TypeRefElem | undefined {
  if (param?.kind === 'type') {
    return param;
  }
  if (param?.kind === 'ref') {
    return {
      kind: 'type',
      name: param.ident,
      start: param.start,
      end: param.end,
    };
  }
  return undefined;
}

/**
 * Translates a WGSL const-expression that evaluates to an integer (an array length or an attribute argument)
 * into an equivalent JS expression.
 */
export function translateExpression(
  expr: ExpressionElem,
  ctx: ExpressionContext,
): string {
  return translateValue(expr, ctx).emit(scalar('i32'));
}

/**
 * Translates a WGSL const-expression into an equivalent JS expression.
 *
 * Supports literals, references to consts, parentheses, scalar arithmetic, comparisons and logic,
 * value constructors (scalars, vectors, matrices, arrays and structs) and component access.
 * Integer division is emitted as truncating division, like in WGSL.
 */
export function translateValue(
  expr: ExpressionElem,
  ctx: ExpressionContext,
): TypedValue {
  const value = locateErrors(expr, () => translateValueUnlocated(expr, ctx));
  return {
    type: value.type,
    emit: (target) => locateErrors(expr, () => value.emit(target)),
  };
}

/** Attaches `expr` to errors that don't know which expression they came from yet. */
function locateErrors<T>(expr: ExpressionElem, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof TranslationError && !error.span) {
      error.span = expr;
    }
    throw error;
  }
}

function translateValueUnlocated(
  expr: ExpressionElem,
  ctx: ExpressionContext,
): TypedValue {
  switch (expr.kind) {
    case 'literal': {
      const type = scalar(literalType(expr.value));
      const code = translateLiteral(expr.value);
      return { type, emit: () => code };
    }
    case 'ref':
      return ctx.resolveValue(expr.ident.originalName);
    case 'parenthesized-expression': {
      const inner = translateValue(expr.expression, ctx);
      return { type: inner.type, emit: (target) => `(${inner.emit(target)})` };
    }
    case 'unary-expression':
      return translateUnary(expr.operator.value, expr.expression, ctx);
    case 'binary-expression':
      return translateBinary(expr.operator.value, expr.left, expr.right, ctx);
    case 'call-expression':
      return translateCall(expr, ctx);
    case 'type':
      throw new UntranslatableExpressionError(
        `type '${expr.name.originalName}' is not a value`,
      );
    case 'component-member-expression':
      return translateMemberAccess(
        translateValue(expr.base, ctx),
        expr.access.name,
        ctx,
      );
    case 'component-expression':
      return translateIndexAccess(
        translateValue(expr.base, ctx),
        translateExpression(expr.access, ctx),
        ctx,
      );
  }
}

/** Throws unless the type is a scalar (or unknown) satisfying `predicate`. */
function expectScalar(
  type: ValueType,
  what: string,
  predicate: (type: ScalarType) => boolean = () => true,
): void {
  if (type.kind === 'unknown') {
    return;
  }
  if (type.kind !== 'scalar' || !predicate(type.scalar)) {
    throw new UntranslatableExpressionError(
      `${what} is not supported for '${describeType(type)}'`,
    );
  }
}

const isNumeric = (type: ScalarType) => type !== 'bool';
const isBool = (type: ScalarType) => type === 'bool';

function translateUnary(
  op: string,
  operandExpr: ExpressionElem,
  ctx: ExpressionContext,
): TypedValue {
  const operand = translateValue(operandExpr, ctx);
  const predicate =
    op === '-'
      ? isNumeric
      : op === '~'
        ? isIntegerScalar
        : op === '!'
          ? isBool
          : undefined;
  if (!predicate) {
    throw new UntranslatableExpressionError(
      `unary operator '${op}' is not supported`,
    );
  }
  expectScalar(operand.type, `unary operator '${op}'`, predicate);
  return {
    type: operand.type,
    emit: (target) => {
      const code = operand.emit(target);
      // A space keeps `- -x` from turning into the `--` operator.
      return `${op}${code.startsWith(op) ? ' ' : ''}${code}`;
    },
  };
}

const arithmeticOperators = new Set(['+', '-', '*', '/', '%']);
const bitwiseOperators = new Set(['&', '|', '^']);
const shiftOperators = new Set(['<<', '>>']);
const comparisonOperators = new Map([
  ['==', '==='],
  ['!=', '!=='],
  ['<', '<'],
  ['<=', '<='],
  ['>', '>'],
  ['>=', '>='],
]);
const logicalOperators = new Set(['&&', '||']);
/** `&`, `|` and `^` on bools, which would turn them into numbers in JS. */
const boolBitwiseOperators = new Map([
  ['&', '&&'],
  ['|', '||'],
  ['^', '!=='],
]);

function translateBinary(
  op: string,
  leftExpr: ExpressionElem,
  rightExpr: ExpressionElem,
  ctx: ExpressionContext,
): TypedValue {
  const left = translateValue(leftExpr, ctx);
  const right = translateValue(rightExpr, ctx);
  const what = `binary operator '${op}'`;

  if (arithmeticOperators.has(op) || bitwiseOperators.has(op)) {
    const predicate = arithmeticOperators.has(op)
      ? isNumeric
      : (type: ScalarType) => isIntegerScalar(type) || type === 'bool';
    expectScalar(left.type, what, predicate);
    expectScalar(right.type, what, predicate);
    const type = unify(left.type, right.type);
    const isBoolOp = type.kind === 'scalar' && type.scalar === 'bool';
    const jsOp = isBoolOp ? (boolBitwiseOperators.get(op) as string) : op;
    return {
      type,
      emit: (target) => {
        // The operand types decide the operation, the target only matters if they're unknown.
        const operandTarget = type.kind === 'unknown' ? target : undefined;
        const l = left.emit(operandTarget);
        const r = right.emit(operandTarget);
        if (op === '/' && isIntegerDivision(type, target)) {
          return `Math.trunc(${l} / ${r})`;
        }
        return `${l} ${jsOp} ${r}`;
      },
    };
  }

  if (shiftOperators.has(op)) {
    expectScalar(left.type, what, isIntegerScalar);
    expectScalar(right.type, what, isIntegerScalar);
    const unsigned = left.type.kind === 'scalar' && left.type.scalar === 'u32';
    // `>>` on a u32 is a logical shift, which is `>>>` in JS.
    const jsOp = op === '>>' && unsigned ? '>>>' : op;
    return {
      type: left.type,
      emit: (target) => `${left.emit(target)} ${jsOp} ${right.emit()}`,
    };
  }

  const comparison = comparisonOperators.get(op);
  if (comparison) {
    expectScalar(left.type, what);
    expectScalar(right.type, what);
    unify(left.type, right.type);
    return {
      type: scalar('bool'),
      emit: () => `${left.emit()} ${comparison} ${right.emit()}`,
    };
  }

  if (logicalOperators.has(op)) {
    expectScalar(left.type, what, isBool);
    expectScalar(right.type, what, isBool);
    return {
      type: scalar('bool'),
      emit: () => `${left.emit()} ${op} ${right.emit()}`,
    };
  }

  throw new UntranslatableExpressionError(
    `binary operator '${op}' is not supported`,
  );
}

function isIntegerDivision(
  type: ValueType,
  target: ValueType | undefined,
): boolean {
  if (type.kind === 'scalar') {
    return isIntegerScalar(type.scalar);
  }
  // Without knowing the operand types, we go by what the result is used as.
  if (target?.kind === 'scalar' && isIntegerScalar(target.scalar)) {
    return true;
  }
  throw new UntranslatableExpressionError(
    `cannot tell whether '/' divides integers, since the types of its operands are unknown`,
  );
}

const swizzleRegex = /^(?:[xyzw]{1,4}|[rgba]{1,4})$/;
const jsIdentifierRegex = /^[A-Za-z_$][\w$]*$/;

function propertyAccess(name: string): string {
  return jsIdentifierRegex.test(name) ? `.${name}` : `[${genString(name)}]`;
}

function translateMemberAccess(
  base: TypedValue,
  name: string,
  ctx: ExpressionContext,
): TypedValue {
  let type: ValueType;
  const baseType = base.type;
  if (baseType.kind === 'vec' && swizzleRegex.test(name)) {
    type =
      name.length === 1
        ? scalar(baseType.component)
        : { kind: 'vec', size: name.length, component: baseType.component };
  } else if (baseType.kind === 'struct') {
    const member = ctx
      .structMembers(baseType)
      ?.find(([memberName]) => memberName === name);
    if (!member) {
      throw new UntranslatableExpressionError(
        `cannot find the type of member '${name}' of struct '${baseType.name}'`,
      );
    }
    type = member[1];
  } else {
    throw new UntranslatableExpressionError(
      `member access is not supported for '${describeType(baseType)}'`,
    );
  }
  return {
    type,
    emit: (target) =>
      convertValue(
        `${base.emit()}${propertyAccess(name)}`,
        concretize(type),
        target,
        ctx,
      ),
  };
}

function translateIndexAccess(
  base: TypedValue,
  index: string,
  ctx: ExpressionContext,
): TypedValue {
  const baseType = base.type;
  let type: ValueType;
  let access = `[${index}]`;
  if (baseType.kind === 'array') {
    type = baseType.element;
  } else if (baseType.kind === 'vec') {
    type = scalar(baseType.component);
  } else if (baseType.kind === 'mat') {
    type = { kind: 'vec', size: baseType.rows, component: baseType.component };
    access = `.columns[${index}]`;
  } else {
    throw new UntranslatableExpressionError(
      `indexing is not supported for '${describeType(baseType)}'`,
    );
  }
  return {
    type,
    emit: (target) =>
      convertValue(`${base.emit()}${access}`, concretize(type), target, ctx),
  };
}

/** A constructor whose type is inferred from its arguments, e.g. `vec3(...)` or `array(...)`. */
type InferredConstructor =
  | { kind: 'vec'; size: number; component?: undefined }
  | { kind: 'mat'; columns: number; rows: number; component?: undefined }
  | { kind: 'array'; element?: undefined; length?: undefined };

type ConstructorType = ValueType | InferredConstructor;

const vecRegex = /^vec([234])([iufh])?$/;
const matRegex = /^mat([234])x([234])([fh])?$/;

const shorthandComponent: Record<string, ScalarType> = {
  i: 'i32',
  u: 'u32',
  f: 'f32',
  h: 'f16',
};

/**
 * The type a call constructs, or undefined if the callee isn't a type,
 * e.g. `vec3f`, `vec3<f32>`, `vec3` (inferred), `array<f32, 2>`, or a struct.
 */
function constructorType(
  fn: RefIdentElem | TypeRefElem,
  ctx: ExpressionContext,
): ConstructorType | undefined {
  const name = fn.kind === 'ref' ? fn.ident.originalName : fn.name.originalName;
  const templateParams = fn.kind === 'type' ? fn.templateParams : undefined;
  if (templateParams && templateParams.length > 0) {
    return resolveTypeRef(fn as TypeRefElem, ctx);
  }
  if (scalarTypes.has(name)) {
    return scalar(name as ScalarType);
  }
  const vec = vecRegex.exec(name);
  if (vec) {
    const size = Number(vec[1]);
    return vec[2]
      ? {
          kind: 'vec',
          size,
          component: shorthandComponent[vec[2]] as ScalarType,
        }
      : { kind: 'vec', size };
  }
  const mat = matRegex.exec(name);
  if (mat) {
    const columns = Number(mat[1]);
    const rows = Number(mat[2]);
    return mat[3]
      ? {
          kind: 'mat',
          columns,
          rows,
          component: shorthandComponent[mat[3]] as ScalarType,
        }
      : { kind: 'mat', columns, rows };
  }
  if (name === 'array') {
    return { kind: 'array' };
  }
  return ctx.resolveNamedType(name);
}

/** Resolves a type annotation (e.g. `vec3f` or `array<MyStruct, N>`) into a value type. */
export function resolveTypeRef(
  typeRef: TypeRefElem,
  ctx: ExpressionContext,
): ValueType {
  const name = typeRef.name.originalName;
  const params = typeRef.templateParams ?? [];
  if (params.length === 0) {
    const type = constructorType(typeRef, ctx);
    if (!type || isPartial(type)) {
      throw new UntranslatableExpressionError(
        `type '${name}' cannot be used for a const`,
      );
    }
    return type;
  }

  const vec = /^vec([234])$/.exec(name);
  const mat = matRegex.exec(name);
  if (vec || (mat && !mat[3])) {
    const component = asTypeRef(params[0])?.name.originalName;
    if (!(params.length === 1 && component && scalarTypes.has(component))) {
      throw new TranslationError(`Unsupported ${name} parameters`, typeRef);
    }
    return vec
      ? {
          kind: 'vec',
          size: Number(vec[1]),
          component: component as ScalarType,
        }
      : {
          kind: 'mat',
          columns: Number(mat?.[1]),
          rows: Number(mat?.[2]),
          component: component as ScalarType,
        };
  }
  if (name === 'array') {
    const elementRef = asTypeRef(params[0]);
    if (!elementRef || params.length > 2) {
      throw new TranslationError('Unsupported array parameters', typeRef);
    }
    const lengthExpr = params[1];
    if (!lengthExpr) {
      throw new UntranslatableExpressionError(
        'runtime-sized arrays cannot be used for a const',
      );
    }
    const element = resolveTypeRef(elementRef, ctx);
    const length =
      lengthExpr.kind === 'literal'
        ? Number(translateLiteral(lengthExpr.value))
        : { code: translateExpression(lengthExpr, ctx), module: ctx.module };
    return { kind: 'array', element, length };
  }
  throw new UntranslatableExpressionError(
    `type '${name}' cannot be used for a const`,
  );
}

function isPartial(type: ConstructorType): type is InferredConstructor {
  return (
    ((type.kind === 'vec' || type.kind === 'mat') && !type.component) ||
    (type.kind === 'array' && !type.element)
  );
}

function translateCall(
  expr: FunctionCallExpression,
  ctx: ExpressionContext,
): TypedValue {
  const fn = expr.function;
  const ctor = constructorType(fn, ctx);
  if (!ctor) {
    const name =
      fn.kind === 'ref' ? fn.ident.originalName : fn.name.originalName;
    throw new UntranslatableExpressionError(
      `function calls ('${name}(...)') are not supported`,
    );
  }
  const args = expr.arguments.map((arg) => translateValue(arg, ctx));
  const type = inferConstructedType(ctor, args);
  return {
    type,
    emit: (target) => {
      // An explicitly typed constructor (e.g. `vec3f(...)`) creates its own type, which is then converted,
      // while an inferred one (e.g. `vec3(...)`) can create the target type directly.
      const created = isPartial(ctor)
        ? pickType(type, target)
        : concretize(type);
      return convertValue(
        emitConstructor(created, args, ctx),
        created,
        target,
        ctx,
      );
    },
  };
}

function inferConstructedType(
  ctor: ConstructorType,
  args: TypedValue[],
): ValueType {
  if (!isPartial(ctor)) {
    const type = ctor;
    if (type.kind === 'array' && args.length > 0) {
      for (const arg of args) {
        unify(type.element, arg.type);
      }
    }
    return type;
  }
  if (args.length === 0) {
    throw new UntranslatableExpressionError(
      `cannot infer the type of '${ctor.kind}()' without arguments`,
    );
  }
  if (ctor.kind === 'array') {
    const element = args
      .map((arg) => arg.type)
      .reduce((acc, type) => unify(acc, type));
    return { kind: 'array', element, length: args.length };
  }
  let component = args
    .map((arg): ValueType => {
      const { type } = arg;
      return type.kind === 'vec' || type.kind === 'mat'
        ? scalar(type.component)
        : type;
    })
    .reduce((acc, type) => unify(acc, type));
  if (component.kind === 'unknown') {
    throw new UntranslatableExpressionError(
      `cannot infer the component type of '${ctor.kind}(...)'`,
    );
  }
  if (component.kind !== 'scalar') {
    throw new UntranslatableExpressionError(
      `invalid arguments for '${ctor.kind}(...)'`,
    );
  }
  if (ctor.kind === 'mat' && component.scalar === 'abstract-int') {
    // Matrices only have float components.
    component = scalar('abstract-float');
  }
  return { ...ctor, component: component.scalar };
}

/** The type to emit a value of type `type` as, given what it's used for. */
function pickType(type: ValueType, target: ValueType | undefined): ValueType {
  if (!target || !isAbstract(type)) {
    return concretize(type);
  }
  const sameShape =
    (type.kind === 'scalar' && target.kind === 'scalar') ||
    (type.kind === 'vec' &&
      target.kind === 'vec' &&
      type.size === target.size) ||
    (type.kind === 'mat' &&
      target.kind === 'mat' &&
      type.columns === target.columns &&
      type.rows === target.rows) ||
    (type.kind === 'array' && target.kind === 'array');
  return sameShape ? target : concretize(type);
}

function isAbstract(type: ValueType): boolean {
  switch (type.kind) {
    case 'scalar':
      return type.scalar.startsWith('abstract');
    case 'vec':
    case 'mat':
      return type.component.startsWith('abstract');
    case 'array':
      return isAbstract(type.element);
    default:
      return false;
  }
}

/** Emits a constructor call creating a value of the (concrete) type `type`. */
function emitConstructor(
  type: ValueType,
  args: TypedValue[],
  ctx: ExpressionContext,
): string {
  switch (type.kind) {
    case 'scalar': {
      const [arg] = args;
      if (!arg) {
        return type.scalar === 'bool' ? 'false' : '0';
      }
      if (args.length > 1) {
        throw new UntranslatableExpressionError(
          `too many arguments for '${type.scalar}(...)'`,
        );
      }
      const code = arg.emit();
      const argType = arg.type;
      // Converting to the same type, or an abstract int to any number, doesn't change the JS value.
      const isNoOp =
        argType.kind === 'scalar' &&
        (concretizeScalar(argType.scalar) === type.scalar ||
          (argType.scalar === 'abstract-int' && type.scalar !== 'bool'));
      return isNoOp ? code : `${schemaOf(type, ctx)}(${code})`;
    }
    case 'vec':
    case 'mat': {
      const component = type.component;
      // With a single vector or matrix argument, the constructor itself is the conversion.
      const isConversion =
        args.length === 1 && args[0]?.type.kind === type.kind;
      const argCodes = args.map((arg) => {
        const argType = arg.type;
        if (isConversion || argType.kind === 'unknown') {
          return arg.emit();
        }
        return arg.emit(
          argType.kind === 'vec' || argType.kind === 'mat'
            ? { ...argType, component }
            : scalar(component),
        );
      });
      return `${schemaOf(type, ctx)}(${argCodes.join(', ')})`;
    }
    case 'array':
      if (args.length === 0) {
        return `${schemaOf(type, ctx)}()`;
      }
      return `[${args.map((arg) => arg.emit(type.element)).join(', ')}]`;
    case 'struct': {
      const schema = schemaOf(type, ctx);
      if (args.length === 0) {
        return `${schema}()`;
      }
      const members = ctx.structMembers(type);
      if (!members) {
        throw new UntranslatableExpressionError(
          `cannot find the members of struct '${type.name}'`,
        );
      }
      if (members.length !== args.length) {
        throw new UntranslatableExpressionError(
          `struct '${type.name}' has ${members.length} members, but ${args.length} arguments were given`,
        );
      }
      const fields = members.map(([name, memberType], i) => {
        const key = jsIdentifierRegex.test(name) ? name : genString(name);
        return `${key}: ${(args[i] as TypedValue).emit(memberType.kind === 'unknown' ? undefined : memberType)}`;
      });
      return `${schema}({ ${fields.join(', ')} })`;
    }
    case 'unknown':
      throw new UntranslatableExpressionError('its type cannot be inferred');
  }
}

/** Calls `visit` with every name (of a value or a type) referenced by `expr`. */
export function forEachReferencedIdentifier(
  expr: ExpressionElem,
  visit: (name: string) => void,
): void {
  switch (expr.kind) {
    case 'ref':
      visit(expr.ident.originalName);
      return;
    case 'type':
      visit(expr.name.originalName);
      for (const param of expr.templateParams ?? []) {
        forEachReferencedIdentifier(param, visit);
      }
      return;
    case 'parenthesized-expression':
    case 'unary-expression':
      forEachReferencedIdentifier(expr.expression, visit);
      return;
    case 'binary-expression':
      forEachReferencedIdentifier(expr.left, visit);
      forEachReferencedIdentifier(expr.right, visit);
      return;
    case 'call-expression':
      forEachReferencedIdentifier(expr.function, visit);
      for (const arg of expr.arguments) {
        forEachReferencedIdentifier(arg, visit);
      }
      return;
    case 'component-expression':
      forEachReferencedIdentifier(expr.base, visit);
      forEachReferencedIdentifier(expr.access, visit);
      return;
    case 'component-member-expression':
      forEachReferencedIdentifier(expr.base, visit);
      return;
    case 'literal':
      return;
  }
}

const decimalInt = /^(0|[1-9][0-9]*)[iu]?$/;
const hexInt = /^0[xX][0-9a-fA-F]+[iu]?$/;
const decimalFloat =
  /^(?:(?:[0-9]*\.[0-9]+|[0-9]+\.[0-9]*)(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)[fh]?$|^(?:0|[1-9][0-9]*)[fh]$/;
const hexFloat =
  /^0[xX](?:([0-9a-fA-F]*)\.([0-9a-fA-F]*)(?:[pP]([+-]?[0-9]+)[fh]?)?|([0-9a-fA-F]+)[pP]([+-]?[0-9]+)[fh]?)$/;

/** The type of a WGSL literal, see https://www.w3.org/TR/WGSL/#literals. */
function literalType(literal: string): ScalarType {
  if (literal === 'true' || literal === 'false') {
    return 'bool';
  }
  if (decimalInt.test(literal) || hexInt.test(literal)) {
    return literal.endsWith('i')
      ? 'i32'
      : literal.endsWith('u')
        ? 'u32'
        : 'abstract-int';
  }
  if (literal.endsWith('h')) {
    return 'f16';
  }
  // In hex floats, `f` is a digit unless it follows the exponent.
  const isHex = /^0[xX]/.test(literal);
  if (isHex ? /[pP][+-]?[0-9]+f$/.test(literal) : literal.endsWith('f')) {
    return 'f32';
  }
  return 'abstract-float';
}

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

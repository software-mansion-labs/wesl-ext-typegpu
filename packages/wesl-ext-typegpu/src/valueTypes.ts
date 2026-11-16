import { UntranslatableExpressionError } from './errors.ts';

/**
 * Types of WGSL values that a const can hold, see https://www.w3.org/TR/WGSL/#constructible-types.
 * Abstract numeric types are kept until a value has to be emitted, since e.g. `vec3(1, 2, 3)` is a
 * `vec3<i32>` on its own, but a `vec3<f32>` when it's used to initialize a `vec3f`.
 */
export type ScalarType =
  | 'bool'
  | 'i32'
  | 'u32'
  | 'f32'
  | 'f16'
  | 'abstract-int'
  | 'abstract-float';

export type ValueType =
  | { kind: 'scalar'; scalar: ScalarType }
  | { kind: 'vec'; size: number; component: ScalarType }
  | { kind: 'mat'; columns: number; rows: number; component: ScalarType }
  | {
      kind: 'array';
      element: ValueType;
      /**
       * The element count, either known up front, or a JS expression that is only valid in the module
       * the type was written in (e.g. `N.$` for `array<f32, N>`).
       */
      length: number | { code: string; module: string };
    }
  /** A struct declared in `module` (e.g. `package::folder::file` or `lygia::math`). */
  | { kind: 'struct'; module: string; name: string }
  /** The type of a value whose declaration could not be analyzed, e.g. a const imported from a missing module. */
  | { kind: 'unknown' };

export type StructType = Extract<ValueType, { kind: 'struct' }>;
export type ScalarValueType = Extract<ValueType, { kind: 'scalar' }>;

export const scalarTypes: Set<string> = new Set<string>([
  'bool',
  'i32',
  'u32',
  'f32',
  'f16',
]);

export function scalar(type: ScalarType): ScalarValueType {
  return { kind: 'scalar', scalar: type };
}

export const unknownType: ValueType = { kind: 'unknown' };

export function isIntegerScalar(type: ScalarType): boolean {
  return type === 'i32' || type === 'u32' || type === 'abstract-int';
}

export function isFloatScalar(type: ScalarType): boolean {
  return type === 'f32' || type === 'f16' || type === 'abstract-float';
}

/** The concrete type a value of an abstract type becomes when it isn't converted to anything else. */
export function concretize(type: ValueType): ValueType {
  switch (type.kind) {
    case 'scalar':
      return scalar(concretizeScalar(type.scalar));
    case 'vec':
    case 'mat':
      return { ...type, component: concretizeScalar(type.component) };
    case 'array':
      return { ...type, element: concretize(type.element) };
    default:
      return type;
  }
}

export function concretizeScalar(type: ScalarType): ScalarType {
  return type === 'abstract-int'
    ? 'i32'
    : type === 'abstract-float'
      ? 'f32'
      : type;
}

/**
 * The common type that values of both types can be converted to, used for the operands of binary
 * operators and the arguments of inferred constructors (e.g. `vec3(1, 2.0, x)`).
 * See https://www.w3.org/TR/WGSL/#conversion-rank.
 */
export function unify(a: ValueType, b: ValueType): ValueType {
  if (a.kind === 'unknown' || b.kind === 'unknown') {
    return unknownType;
  }
  if (a.kind === 'scalar' && b.kind === 'scalar') {
    return scalar(unifyScalars(a.scalar, b.scalar));
  }
  if (a.kind === 'vec' && b.kind === 'vec' && a.size === b.size) {
    return { ...a, component: unifyScalars(a.component, b.component) };
  }
  if (
    a.kind === 'mat' &&
    b.kind === 'mat' &&
    a.columns === b.columns &&
    a.rows === b.rows
  ) {
    return { ...a, component: unifyScalars(a.component, b.component) };
  }
  if (a.kind === 'array' && b.kind === 'array') {
    return { ...a, element: unify(a.element, b.element) };
  }
  if (
    a.kind === 'struct' &&
    b.kind === 'struct' &&
    a.module === b.module &&
    a.name === b.name
  ) {
    return a;
  }
  throw new UntranslatableExpressionError(
    `mismatched types '${describeType(a)}' and '${describeType(b)}'`,
  );
}

function unifyScalars(a: ScalarType, b: ScalarType): ScalarType {
  if (a === b) {
    return a;
  }
  if (a === 'abstract-int' && b !== 'bool') {
    return b;
  }
  if (b === 'abstract-int' && a !== 'bool') {
    return a;
  }
  if (a === 'abstract-float' && isFloatScalar(b)) {
    return b;
  }
  if (b === 'abstract-float' && isFloatScalar(a)) {
    return a;
  }
  throw new UntranslatableExpressionError(`mismatched types '${a}' and '${b}'`);
}

/** The WGSL spelling of a type, for error messages. */
export function describeType(type: ValueType): string {
  switch (type.kind) {
    case 'scalar':
      return describeScalar(type.scalar);
    case 'vec':
      return `vec${type.size}<${describeScalar(type.component)}>`;
    case 'mat':
      return `mat${type.columns}x${type.rows}<${describeScalar(type.component)}>`;
    case 'array':
      return `array<${describeType(type.element)}${typeof type.length === 'number' ? `, ${type.length}` : ''}>`;
    case 'struct':
      return type.name;
    case 'unknown':
      return 'unknown';
  }
}

function describeScalar(type: ScalarType): string {
  return type === 'abstract-int'
    ? 'AbstractInt'
    : type === 'abstract-float'
      ? 'AbstractFloat'
      : type;
}

/**
 * Matrix schemas exported by `typegpu/data`. WGSL also has non-square and `f16` matrices,
 * but TypeGPU has no schema for them, so we report those instead of emitting a reference
 * to something undefined.
 */
export const supportedMatrices: Set<string> = new Set([
  'mat2x2f',
  'mat3x3f',
  'mat4x4f',
]);

const vecSuffix: Record<ScalarType, string> = {
  bool: 'b',
  i32: 'i',
  u32: 'u',
  f32: 'f',
  f16: 'h',
  'abstract-int': 'i',
  'abstract-float': 'f',
};

export interface SchemaContext {
  /** Local name of the `typegpu/data` namespace import. */
  data: string;
  /** JS expression for the schema of a struct. */
  structSchema(type: StructType): string;
  /** Path of the module the schema is emitted into. */
  module: string;
}

/** JS expression for the TypeGPU schema of a (concretized) type. */
export function schemaOf(type: ValueType, ctx: SchemaContext): string {
  switch (type.kind) {
    case 'scalar':
      return `${ctx.data}.${concretizeScalar(type.scalar)}`;
    case 'vec':
      return `${ctx.data}.vec${type.size}${vecSuffix[type.component]}`;
    case 'mat': {
      const name = `mat${type.columns}x${type.rows}${vecSuffix[type.component]}`;
      if (!supportedMatrices.has(name)) {
        throw new UntranslatableExpressionError(
          `Matrix type '${describeType(concretize(type))}' is not supported by TypeGPU, supported matrix types are: ${[...supportedMatrices].join(', ')}`,
        );
      }
      return `${ctx.data}.${name}`;
    }
    case 'array': {
      const { length } = type;
      if (typeof length !== 'number' && length.module !== ctx.module) {
        throw new UntranslatableExpressionError(
          `the length of '${describeType(type)}' is declared in module '${length.module}'`,
        );
      }
      return `${ctx.data}.arrayOf(${schemaOf(type.element, ctx)}, ${typeof length === 'number' ? length : length.code})`;
    }
    case 'struct':
      return ctx.structSchema(type);
    case 'unknown':
      throw new UntranslatableExpressionError('its type cannot be inferred');
  }
}

/**
 * Converts a JS value of type `from` (as created by TypeGPU, so abstract types are already concretized)
 * into a value of type `to`. Scalars are plain JS numbers or booleans either way.
 */
export function convertValue(
  code: string,
  from: ValueType,
  to: ValueType | undefined,
  ctx: SchemaContext,
  depth = 0,
): string {
  if (!to || from.kind === 'unknown' || to.kind === 'unknown') {
    return code;
  }
  switch (to.kind) {
    case 'vec':
    case 'mat':
      return schemaOf(concretize(from), ctx) === schemaOf(to, ctx)
        ? code
        : `${schemaOf(to, ctx)}(${code})`;
    case 'array': {
      if (from.kind !== 'array') {
        return code;
      }
      const element = `e${depth}`;
      const converted = convertValue(
        element,
        from.element,
        to.element,
        ctx,
        depth + 1,
      );
      return converted === element
        ? code
        : `${code}.map((${element}) => ${converted})`;
    }
    default:
      return code;
  }
}

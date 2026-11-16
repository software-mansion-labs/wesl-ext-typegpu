import type { AttributeElem, TypeRefElem, TypeTemplateParameter } from 'wesl';

import { TranslationError } from './errors.ts';
import { type ExpressionContext, translateExpression } from './expressions.ts';

const vecResolveMap: Record<string, string> = {
  bool: 'b',
  AbstractInt: 'i',
  AbstractFloat: 'f',
  i32: 'i',
  u32: 'u',
  f32: 'f',
  f16: 'h',
};

const matResolveMap: Record<string, string> = {
  f32: 'f',
  f16: 'h',
};

/**
 * Matrix schemas exported by `typegpu/data`. WGSL also has non-square and `f16` matrices,
 * but TypeGPU has no schema for them, so we report those instead of emitting a reference
 * to something undefined.
 */
const supportedMatrices = new Set(['mat2x2f', 'mat3x3f', 'mat4x4f']);

const matrixTypeRegex = /^mat[234]x[234]$/;
const matrixShorthandRegex = /^mat[234]x[234][fh]$/;

const addressSpaceMap: Record<string, string> = {
  function: 'ptrFn',
  private: 'ptrPrivate',
  workgroup: 'ptrWorkgroup',
  uniform: 'ptrUniform',
  storage: 'ptrStorage',
  handle: 'ptrHandle',
};

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

export function generateType(
  typeRef: TypeRefElem,
  importsNamespace: Set<string>,
  ctx: ExpressionContext,
): string {
  const typeName = typeRef.name.originalName;

  if (importsNamespace.has(typeName)) {
    return ctx.names.local(typeName);
  }
  if (typeName.includes('::')) {
    return typeName.replaceAll('::', '$');
  }

  switch (typeName) {
    case 'vec2': // Fallthrough
    case 'vec3': // Fallthrough
    case 'vec4':
      return parseVectorType(typeRef, ctx);
    case 'array':
      return parseArrayType(typeRef, importsNamespace, ctx);
    case 'atomic':
      return parseAtomicType(typeRef, importsNamespace, ctx);
    case 'ptr':
      return parsePtrType(typeRef, importsNamespace, ctx);
    default:
      if (matrixTypeRegex.test(typeName)) {
        return parseMatrixType(typeRef, ctx);
      }
      if (matrixShorthandRegex.test(typeName)) {
        return resolveMatrixSchema(ctx, typeRef, typeName);
      }
      return `${ctx.names.data}.${typeName}`;
  }
}

function parseVectorType(typeRef: TypeRefElem, ctx: ExpressionContext): string {
  const params = typeRef.templateParams ?? [];
  const componentType = asTypeRef(params[0])?.name.originalName;
  if (
    !(params.length === 1 && componentType && componentType in vecResolveMap)
  ) {
    throw new TranslationError('Unsupported vector parameters', typeRef);
  }
  return `${ctx.names.data}.${typeRef.name.originalName}${vecResolveMap[componentType]}`;
}

function parseMatrixType(typeRef: TypeRefElem, ctx: ExpressionContext): string {
  const typeName = typeRef.name.originalName;
  const params = typeRef.templateParams ?? [];
  const componentType = asTypeRef(params[0])?.name.originalName;
  if (
    !(params.length === 1 && componentType && componentType in matResolveMap)
  ) {
    throw new TranslationError(
      `Unsupported matrix parameters for '${typeName}', expected a single f32 or f16 component type`,
      typeRef,
    );
  }
  return resolveMatrixSchema(
    ctx,
    typeRef,
    `${typeName}${matResolveMap[componentType]}`,
    `${typeName}<${componentType}>`,
  );
}

function resolveMatrixSchema(
  ctx: ExpressionContext,
  typeRef: TypeRefElem,
  schemaName: string,
  wgslName = schemaName,
): string {
  if (!supportedMatrices.has(schemaName)) {
    throw new TranslationError(
      `Matrix type '${wgslName}' is not supported by TypeGPU, supported matrix types are: ${[...supportedMatrices].join(', ')}`,
      typeRef,
    );
  }
  return `${ctx.names.data}.${schemaName}`;
}

function parseArrayType(
  typeRef: TypeRefElem,
  identifiersNamespace: Set<string>,
  ctx: ExpressionContext,
): string {
  const params = typeRef.templateParams ?? [];
  const elementType = asTypeRef(params[0]);
  if (!([1, 2].includes(params.length) && elementType)) {
    throw new TranslationError('Unsupported array parameters', typeRef);
  }
  const subType = generateType(elementType, identifiersNamespace, ctx);
  if (params[1]) {
    const length = translateExpression(params[1], ctx);
    return `${ctx.names.data}.arrayOf(${subType}, ${length})`;
  }
  return `${ctx.names.data}.arrayOf(${subType}, ${ctx.names.arrayLength})`;
}

function parseAtomicType(
  typeRef: TypeRefElem,
  identifiersNamespace: Set<string>,
  ctx: ExpressionContext,
): string {
  const params = typeRef.templateParams ?? [];
  const innerType = asTypeRef(params[0]);
  if (!(params.length === 1 && innerType)) {
    throw new TranslationError('Unsupported atomic parameters', typeRef);
  }
  const subType = generateType(innerType, identifiersNamespace, ctx);
  return `${ctx.names.data}.atomic(${subType})`;
}

function parsePtrType(
  typeRef: TypeRefElem,
  identifiersNamespace: Set<string>,
  ctx: ExpressionContext,
): string {
  const params = typeRef.templateParams ?? [];
  const addressSpaceRef = asTypeRef(params[0]);
  const innerType = asTypeRef(params[1]);
  if (!([2, 3].includes(params.length) && addressSpaceRef && innerType)) {
    throw new TranslationError('Unsupported ptr parameters', typeRef);
  }
  const accessModeRef = asTypeRef(params[2]);
  if (params[2] && !accessModeRef) {
    throw new TranslationError('Invalid ptr memory access mode', params[2]);
  }
  const addressSpace = addressSpaceRef.name.originalName;
  if (!(addressSpace in addressSpaceMap)) {
    throw new TranslationError('Invalid ptr address space', addressSpaceRef);
  }
  const ptrName = addressSpaceMap[addressSpace];
  const subType = generateType(innerType, identifiersNamespace, ctx);
  const accessMode = accessModeRef?.name.originalName.replaceAll('_', '-');

  // all pointers accept exactly one argument except for ptrStorage
  return `${ctx.names.data}.${ptrName}(${subType}${ptrName === 'ptrStorage' && accessMode ? `, "${accessMode}"` : ''})`;
}

/**
 * Attributes (written as `@name(...)` in WGSL) that have a counterpart in `typegpu/data`,
 * mapped to the name of that counterpart. `@interpolate` and `@builtin` are parsed into
 * their own element kinds by wesl, so they are handled separately.
 */
const attributeMap = new Map([
  ['align', 'align'],
  ['size', 'size'],
  ['location', 'location'],
  ['invariant', 'invariant'],
]);

/**
 * Builtin values (written as `@builtin(name)` in WGSL) available on `${ctx.names.data}.builtin` in `typegpu/data`.
 */
const builtinNames = new Set([
  'clip_distances',
  'frag_depth',
  'front_facing',
  'global_invocation_id',
  'global_invocation_index',
  'instance_index',
  'local_invocation_id',
  'local_invocation_index',
  'num_subgroups',
  'num_workgroups',
  'position',
  'primitive_index',
  'sample_index',
  'sample_mask',
  'subgroup_id',
  'subgroup_invocation_id',
  'subgroup_size',
  'vertex_index',
  'workgroup_id',
  'workgroup_index',
]);

export function wrapInAttributes(
  type: string,
  attributes: AttributeElem[] | undefined,
  ctx: ExpressionContext,
): string {
  if (!attributes) {
    return type;
  }

  // `${ctx.names.data}.builtin.*` values already carry their data type, so a builtin replaces the base type
  // instead of wrapping it. It is applied first so that the other attributes wrap it no matter
  // where `@builtin` appears among them.
  const builtins = attributes.filter(
    (attribute) => attribute.attribute.kind === '@builtin',
  );
  if (builtins.length > 1) {
    throw new TranslationError(
      'Multiple @builtin attributes on a single declaration',
      builtins[1],
    );
  }
  const base =
    builtins.length > 0 ? wrapInAttribute(type, builtins[0], ctx) : type;

  // Wrapping from the last attribute outwards keeps the first attribute as the outermost call,
  // so the nesting reads in source order. TypeGPU prepends each attribute it applies, so this
  // also makes the generated WGSL list the attributes in source order.
  return attributes
    .filter((attribute) => attribute.attribute.kind !== '@builtin')
    .reduceRight(
      (acc, attribute) => wrapInAttribute(acc, attribute, ctx),
      base,
    );
}

function wrapInAttribute(
  acc: string,
  attribute: AttributeElem,
  ctx: ExpressionContext,
): string {
  switch (attribute.attribute.kind) {
    case '@attribute': {
      const { name } = attribute.attribute;
      const tgpuName = attributeMap.get(name);
      if (!tgpuName) {
        throw new TranslationError(
          `Attribute @${name} is not supported by TypeGPU`,
          attribute,
        );
      }
      const args = attribute.attribute.params
        ?.map((param) => translateExpression(param.expression, ctx))
        .join(', ');
      return `${ctx.names.data}.${tgpuName}(${args ? `${args}, ` : ''}${acc})`;
    }
    case '@interpolate': {
      if (
        !(
          attribute.attribute.params &&
          [1, 2].includes(attribute.attribute.params.length)
        )
      ) {
        throw new TranslationError(
          'Invalid interpolation parameters',
          attribute,
        );
      }
      const param = attribute.attribute.params
        .map((elem) => elem.name)
        .join(', ');
      return `${ctx.names.data}.interpolate("${param}", ${acc})`;
    }
    case '@builtin': {
      const { name } = attribute.attribute.param;
      if (!builtinNames.has(name)) {
        throw new TranslationError(
          `Builtin value ${name} is not supported by TypeGPU`,
          attribute,
        );
      }
      return `${ctx.names.data}.builtin.${snakeToCamel(name)}`;
    }
    case '@diagnostic':
      throw new TranslationError(
        'Diagnostic attributes are not supported by TypeGPU',
        attribute,
      );
    case '@if':
    case '@elif':
    case '@else':
      // Conditions are evaluated before translation, so anything still carrying one is included.
      return acc;
  }
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

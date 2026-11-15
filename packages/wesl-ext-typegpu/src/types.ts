import type {
  AttributeElem,
  ExpressionElem,
  TypeRefElem,
  TypeTemplateParameter,
} from 'wesl';

export const VariableSizedArrayParam = '__arrayLength';

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
  src: string,
): string {
  const typeName = typeRef.name.originalName;

  if (importsNamespace.has(typeName) || typeName.includes('::')) {
    return typeName.replaceAll('::', '$');
  }

  switch (typeName) {
    case 'vec2': // Fallthrough
    case 'vec3': // Fallthrough
    case 'vec4':
      return parseVectorType(typeRef);
    case 'array':
      return parseArrayType(typeRef, importsNamespace, src);
    case 'atomic':
      return parseAtomicType(typeRef, importsNamespace, src);
    case 'ptr':
      return parsePtrType(typeRef, importsNamespace, src);
    default:
      if (matrixTypeRegex.test(typeName)) {
        return parseMatrixType(typeRef);
      }
      if (matrixShorthandRegex.test(typeName)) {
        return resolveMatrixSchema(typeName);
      }
      return `d.${typeName}`;
  }
}

function parseVectorType(typeRef: TypeRefElem): string {
  const params = typeRef.templateParams ?? [];
  const componentType = asTypeRef(params[0])?.name.originalName;
  if (
    !(params.length === 1 && componentType && componentType in vecResolveMap)
  ) {
    throw new Error('Unsupported vector parameters!');
  }
  return `d.${typeRef.name.originalName}${vecResolveMap[componentType]}`;
}

function parseMatrixType(typeRef: TypeRefElem): string {
  const typeName = typeRef.name.originalName;
  const params = typeRef.templateParams ?? [];
  const componentType = asTypeRef(params[0])?.name.originalName;
  if (
    !(params.length === 1 && componentType && componentType in matResolveMap)
  ) {
    throw new Error(
      `Unsupported matrix parameters for '${typeName}', expected a single f32 or f16 component type!`,
    );
  }
  return resolveMatrixSchema(
    `${typeName}${matResolveMap[componentType]}`,
    `${typeName}<${componentType}>`,
  );
}

function resolveMatrixSchema(
  schemaName: string,
  wgslName = schemaName,
): string {
  if (!supportedMatrices.has(schemaName)) {
    throw new Error(
      `Matrix type '${wgslName}' is not supported by TypeGPU, supported matrix types are: ${[...supportedMatrices].join(', ')}.`,
    );
  }
  return `d.${schemaName}`;
}

function parseArrayType(
  typeRef: TypeRefElem,
  identifiersNamespace: Set<string>,
  src: string,
): string {
  const params = typeRef.templateParams ?? [];
  const elementType = asTypeRef(params[0]);
  if (!([1, 2].includes(params.length) && elementType)) {
    throw new Error('Unsupported array parameters!');
  }
  const subType = generateType(elementType, identifiersNamespace, src);
  if (params[1]) {
    const length = extractText(params[1], src);
    return `d.arrayOf(${subType}, ${length})`;
  }
  return `d.arrayOf(${subType}, ${VariableSizedArrayParam})`;
}

function parseAtomicType(
  typeRef: TypeRefElem,
  identifiersNamespace: Set<string>,
  src: string,
): string {
  const params = typeRef.templateParams ?? [];
  const innerType = asTypeRef(params[0]);
  if (!(params.length === 1 && innerType)) {
    throw new Error('Unsupported atomic parameters!');
  }
  const subType = generateType(innerType, identifiersNamespace, src);
  return `d.atomic(${subType})`;
}

function parsePtrType(
  typeRef: TypeRefElem,
  identifiersNamespace: Set<string>,
  src: string,
): string {
  const params = typeRef.templateParams ?? [];
  const addressSpaceRef = asTypeRef(params[0]);
  const innerType = asTypeRef(params[1]);
  if (!([2, 3].includes(params.length) && addressSpaceRef && innerType)) {
    throw new Error('Unsupported ptr parameters!');
  }
  const accessModeRef = asTypeRef(params[2]);
  if (params[2] && !accessModeRef) {
    throw new Error('Invalid ptr memory access mode!');
  }
  const addressSpace = addressSpaceRef.name.originalName;
  if (!(addressSpace in addressSpaceMap)) {
    throw new Error('Invalid ptr address space!');
  }
  const ptrName = addressSpaceMap[addressSpace];
  const subType = generateType(innerType, identifiersNamespace, src);
  const accessMode = accessModeRef?.name.originalName.replaceAll('_', '-');

  // all pointers accept exactly one argument except for ptrStorage
  return `d.${ptrName}(${subType}${ptrName === 'ptrStorage' && accessMode ? `, "${accessMode}"` : ''})`;
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
 * Builtin values (written as `@builtin(name)` in WGSL) available on `d.builtin` in `typegpu/data`.
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
  src: string,
): string {
  if (!attributes) {
    return type;
  }

  // `d.builtin.*` values already carry their data type, so a builtin replaces the base type
  // instead of wrapping it. It is applied first so that the other attributes wrap it no matter
  // where `@builtin` appears among them.
  const builtins = attributes.filter(
    (attribute) => attribute.attribute.kind === '@builtin',
  );
  if (builtins.length > 1) {
    throw new Error('Multiple @builtin attributes on a single declaration!');
  }
  const base =
    builtins.length > 0 ? wrapInAttribute(type, builtins[0], src) : type;

  return attributes
    .filter((attribute) => attribute.attribute.kind !== '@builtin')
    .reduce((acc, attribute) => wrapInAttribute(acc, attribute, src), base);
}

function wrapInAttribute(
  acc: string,
  attribute: AttributeElem,
  src: string,
): string {
  switch (attribute.attribute.kind) {
    case '@attribute': {
      const { name } = attribute.attribute;
      const tgpuName = attributeMap.get(name);
      if (!tgpuName) {
        throw new Error(`Attribute @${name} is not supported by TypeGPU!`);
      }
      const args = attribute.attribute.params
        ?.map((param) => extractText(param.expression, src))
        .join(', ');
      return `d.${tgpuName}(${args ? `${args}, ` : ''}${acc})`;
    }
    case '@interpolate': {
      if (
        !(
          attribute.attribute.params &&
          [1, 2].includes(attribute.attribute.params.length)
        )
      ) {
        throw new Error('Invalid interpolation parameters!');
      }
      const param = attribute.attribute.params
        .map((elem) => elem.name)
        .join(', ');
      return `d.interpolate("${param}", ${acc})`;
    }
    case '@builtin': {
      const { name } = attribute.attribute.param;
      if (!builtinNames.has(name)) {
        throw new Error(`Builtin value ${name} is not supported by TypeGPU!`);
      }
      return `d.builtin.${snakeToCamel(name)}`;
    }
    case '@diagnostic':
      throw new Error('Diagnostic attributes are not supported by TGSL!');
    case '@if':
    case '@elif':
    case '@else':
      throw new Error('Conditional attributes are not supported by TGSL!');
  }
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function extractText(element: ExpressionElem, src: string): string {
  return src.substring(element.start, element.end).replaceAll('_', '-');
}

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

export function wrapInAttributes(
  type: string,
  attributes: AttributeElem[] | undefined,
  src: string,
): string {
  if (!attributes) {
    return type;
  }
  return attributes.reduce((acc, attribute) => {
    switch (attribute.attribute.kind) {
      case '@attribute': {
        const args = attribute.attribute.params
          ?.map((param) => extractText(param.expression, src))
          .join(', ');
        return `d.${attribute.attribute.name}(${args ? `${args}, ` : ''}${acc})`;
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
        return `d.builtin.${snakeToCamel(attribute.attribute.param.name)}`;
      }
      case '@diagnostic':
        throw new Error('Diagnostic attributes are not supported by TGSL!');
      case '@if':
      case '@elif':
      case '@else':
        throw new Error('Conditional attributes are not supported by TGSL!');
    }
  }, type);
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function extractText(element: ExpressionElem, src: string): string {
  return src.substring(element.start, element.end).replaceAll('_', '-');
}

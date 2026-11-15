import type { AttributeElem, TypeRefElem, UnknownExpressionElem } from 'wesl';

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

export function generateType(
  typeRef: TypeRefElem,
  importsNamespace: Set<string>,
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
      return parseArrayType(typeRef, importsNamespace);
    case 'atomic':
      return parseAtomicType(typeRef, importsNamespace);
    case 'ptr':
      return parsePtrType(typeRef, importsNamespace);
    default:
      return `d.${typeName}`;
  }
}

function parseVectorType(typeRef: TypeRefElem): string {
  if (
    !(
      typeRef.templateParams &&
      typeRef.templateParams.length === 1 &&
      typeRef.templateParams[0].kind === 'type' &&
      typeRef.templateParams[0].name.originalName in vecResolveMap
    )
  ) {
    throw new Error('Unsupported vector parameters!');
  }
  return `d.${typeRef.name.originalName}${vecResolveMap[typeRef.templateParams[0].name.originalName]}`;
}

function parseArrayType(
  typeRef: TypeRefElem,
  identifiersNamespace: Set<string>,
): string {
  if (
    !(
      typeRef.templateParams &&
      [1, 2].includes(typeRef.templateParams.length) &&
      typeRef.templateParams[0].kind === 'type'
    )
  ) {
    throw new Error('Unsupported array parameters!');
  }
  const subType = generateType(typeRef.templateParams[0], identifiersNamespace);
  if (
    typeRef.templateParams[1] &&
    typeRef.templateParams[1].kind === 'expression'
  ) {
    const length = tryExtractText(typeRef.templateParams[1]);
    return `d.arrayOf(${subType}, ${length})`;
  }
  return `d.arrayOf(${subType}, ${VariableSizedArrayParam})`;
}

function parseAtomicType(
  typeRef: TypeRefElem,
  identifiersNamespace: Set<string>,
) {
  if (
    !(
      typeRef.templateParams &&
      typeRef.templateParams.length === 1 &&
      typeRef.templateParams[0].kind === 'type'
    )
  ) {
    throw new Error('Unsupported atomic parameters!');
  }
  const subType = generateType(typeRef.templateParams[0], identifiersNamespace);
  return `d.atomic(${subType})`;
}

function parsePtrType(
  typeRef: TypeRefElem,
  identifiersNamespace: Set<string>,
): string {
  if (
    !(
      typeRef.templateParams &&
      [2, 3].includes(typeRef.templateParams.length) &&
      typeRef.templateParams[0].kind === 'type' &&
      typeRef.templateParams[1].kind === 'type'
    )
  ) {
    throw new Error('Unsupported ptr parameters!');
  }
  if (
    !(typeRef.templateParams[2] && typeRef.templateParams[2].kind === 'type')
  ) {
    throw new Error('Invalid ptr memory access mode!');
  }
  const addressSpace = typeRef.templateParams[0].name.originalName;
  if (!(addressSpace in addressSpaceMap)) {
    throw new Error('Invalid ptr address space!');
  }
  const ptrName = addressSpaceMap[addressSpace];
  const subType = generateType(typeRef.templateParams[1], identifiersNamespace);
  const possibleMemoryAccessMode =
    typeRef.templateParams[2]?.name.originalName.replaceAll('_', '-');

  // all pointers accept exactly one argument except for ptrStorage
  return `d.${ptrName}(${subType}${ptrName === 'ptrStorage' ? `, "${possibleMemoryAccessMode}"` : ''})`;
}

export function wrapInAttributes(
  type: string,
  attributes: AttributeElem[] | undefined,
): string {
  if (!attributes) {
    return type;
  }
  return attributes.reduce((acc, attribute) => {
    switch (attribute.attribute.kind) {
      case '@attribute': {
        const args = attribute.attribute.params
          ?.map((param) => tryExtractText(param))
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
        let param = attribute.attribute.params[0].name;
        if (attribute.attribute.params.length === 2) {
          param += `, ${attribute.attribute.params[1].name}`;
        }
        return `d.interpolate("${param}", ${acc})`;
      }
      case '@builtin': {
        return `d.builtin.${attribute.attribute.param.name}`;
      }
      case '@diagnostic':
        throw new Error('Diagnostic attributes are not supported by TGSL!');
      case '@if':
        throw new Error('If attributes are not supported by TGSL!');
    }
  }, type);
}

function tryExtractText(element: UnknownExpressionElem): string {
  if (!(element.contents.length > 0 && element.contents[0].kind === 'text')) {
    throw new Error('Unknown expression unparsable to TGSL!');
  }
  return element.contents[0].srcModule.src
    .substring(element.start, element.end)
    .replaceAll('_', '-');
}

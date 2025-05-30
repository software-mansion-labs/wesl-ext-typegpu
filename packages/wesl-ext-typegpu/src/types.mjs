// @ts-check

/** @typedef {import("wesl").AttributeElem} AttributeElem */
/** @typedef {import("wesl").TypeRefElem} TypeRefElem */
/** @typedef {import("wesl").UnknownExpressionElem} UnknownExpressionElem */

export const VariableSizedArrayParam = '__arrayLength';

/** @type {Record<string, string>} */
const vecResolveMap = {
  bool: 'b',
  AbstractInt: 'i',
  AbstractFloat: 'f',
  i32: 'i',
  u32: 'u',
  f32: 'f',
  f16: 'h',
};

/** @type {Record<string, string>} */
const addressSpaceMap = {
  function: 'ptrFn',
  private: 'ptrPrivate',
  workgroup: 'ptrWorkgroup',
  uniform: 'ptrUniform',
  storage: 'ptrStorage',
  handle: 'ptrHandle',
};

/**
 * @param {TypeRefElem} typeRef
 * @param {Set<string>} importsNamespace
 * @returns {string}
 */
export function generateType(typeRef, importsNamespace) {
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

/**
 * @param {TypeRefElem} typeRef
 */
function parseVectorType(typeRef) {
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

/**
 * @param {TypeRefElem} typeRef
 * @param {Set<string>} identifiersNamespace
 */
function parseArrayType(typeRef, identifiersNamespace) {
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

/**
 * @param {TypeRefElem} typeRef
 * @param {Set<string>} identifiersNamespace
 */
function parseAtomicType(typeRef, identifiersNamespace) {
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

/**
 * @param {TypeRefElem} typeRef
 * @param {Set<string>} identifiersNamespace
 */
function parsePtrType(typeRef, identifiersNamespace) {
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

/**
 * @param {string} type
 * @param {AttributeElem[] | undefined} attributes
 */
export function wrapInAttributes(type, attributes) {
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

/**
 * @param {UnknownExpressionElem} element
 */
function tryExtractText(element) {
  if (!(element.contents.length > 0 && element.contents[0].kind === 'text')) {
    throw new Error('Unknown expression unparsable to TGSL!');
  }
  return element.contents[0].srcModule.src
    .substring(element.start, element.end)
    .replaceAll('_', '-');
}

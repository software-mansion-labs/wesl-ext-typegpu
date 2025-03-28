// @ts-check

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").StructElem} StructElem */
/** @typedef {import("wesl").StructMemberElem} StructMemberElem */
/** @typedef {import("wesl").AttributeElem} AttributeElem */
/** @typedef {import("wesl").TypeRefElem} TypeRefElem */
/** @typedef {import("wesl").ImportElem} ImportElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */
/** @typedef {import("wesl").UnknownExpressionElem} UnknownExpressionElem */

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
 * @param {Set<string>} nonTgpuIdentifiers
 * @returns {string}
 */
export function generateType(typeRef, nonTgpuIdentifiers) {
  const typeName = typeRef.name.originalName;

  if (nonTgpuIdentifiers.has(typeName) || typeName.includes('::')) {
    return typeName;
  }

  switch (typeName) {
    case 'vec2':
    case 'vec3':
    case 'vec4':
      return parseVectorType(typeRef);
    case 'array':
      return parseArrayType(typeRef, nonTgpuIdentifiers);
    case 'atomic':
      return parseAtomicType(typeRef, nonTgpuIdentifiers);
    case 'ptr':
      return parsePtrType(typeRef, nonTgpuIdentifiers);
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
 * @param {Set<string>} nonTgpuIdentifiers
 */
function parseArrayType(typeRef, nonTgpuIdentifiers) {
  if (
    !(
      typeRef.templateParams &&
      [1, 2].includes(typeRef.templateParams.length) &&
      typeRef.templateParams[0].kind === 'type'
    )
  ) {
    throw new Error('Unsupported array parameters!');
  }
  if (
    !(
      typeRef.templateParams[1] &&
      typeRef.templateParams[1].kind === 'expression'
    )
  ) {
    throw new Error('Runtime-sized arrays in structs are not supported!');
  }
  const subType = generateType(typeRef.templateParams[0], nonTgpuIdentifiers);
  const length = tryExtractText(typeRef.templateParams[1]);
  return `d.arrayOf(${subType}, ${length})`;
}

/**
 * @param {TypeRefElem} typeRef
 * @param {Set<string>} nonTgpuIdentifiers
 */
function parseAtomicType(typeRef, nonTgpuIdentifiers) {
  if (
    !(
      typeRef.templateParams &&
      typeRef.templateParams.length === 1 &&
      typeRef.templateParams[0].kind === 'type'
    )
  ) {
    throw new Error('Unsupported atomic parameters!');
  }
  const subType = generateType(typeRef.templateParams[0], nonTgpuIdentifiers);
  return `d.atomic(${subType})`;
}

/**
 * @param {TypeRefElem} typeRef
 * @param {Set<string>} nonTgpuIdentifiers
 */
function parsePtrType(typeRef, nonTgpuIdentifiers) {
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
  const subType = generateType(typeRef.templateParams[1], nonTgpuIdentifiers);
  const possibleMemoryAccessMode = typeRef.templateParams[2]?.name.originalName;

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
            attribute.attribute.params.length === 1
          )
        ) {
          throw new Error('Only interpolation type is supported!');
        }
        return `d.interpolate("${attribute.attribute.params[0].name}", ${acc})`;
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
  return element.contents[0].srcModule.src.substring(
    element.start,
    element.end,
  );
}

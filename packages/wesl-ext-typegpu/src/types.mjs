// @ts-check

/** @typedef {import("wesl").AbstractElem} AbstractElem */
/** @typedef {import("wesl").StructElem} StructElem */
/** @typedef {import("wesl").StructMemberElem} StructMemberElem */
/** @typedef {import("wesl").AttributeElem} AttributeElem */
/** @typedef {import("wesl").TypeRefElem} TypeRefElem */
/** @typedef {import("wesl").ImportElem} ImportElem */
/** @typedef {import("wesl").ImportStatement} ImportStatement */
/** @typedef {import("wesl").UnknownExpressionElem} UnknownExpressionElem */

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

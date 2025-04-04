// @ts-check

/**
 * @template {any} T
 * @param {T} item
 */
export function assertDefined(item) {
  if (item === undefined) {
    throw new Error('Not null assertion failed!');
  }
  return item;
}

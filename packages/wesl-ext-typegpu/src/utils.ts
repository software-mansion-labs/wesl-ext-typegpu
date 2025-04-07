export function assertDefined<T>(item: T) {
  if (item === undefined) {
    throw new Error('Not null assertion failed!');
  }
  return item;
}

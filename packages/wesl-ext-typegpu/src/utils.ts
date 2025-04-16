export function assertDefined<T>(item: T | undefined | null): T {
  if (item === undefined || item === null) {
    throw new Error('Not null assertion failed!');
  }
  return item;
}

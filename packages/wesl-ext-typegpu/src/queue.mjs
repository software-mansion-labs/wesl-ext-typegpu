// @ts-check

/**
 * @template T
 * @type {Queue<T>}
 */
export class Queue {
  /** @param {Array<T>} initialElements */
  constructor(initialElements) {
    /** @type {[Array<T>, Array<T>]} */
    this.stacks = [initialElements, []];
  }

  /** @param {T} elem */
  add(elem) {
    this.stacks[0].push(elem);
  }

  /** @returns {T | undefined} */
  remove() {
    if (this.stacks[1].length === 0) {
      this.#relocate();
    }
    return this.stacks[1].pop();
  }

  get length() {
    return this.stacks[0].length + this.stacks[1].length;
  }

  #relocate() {
    while (this.stacks[0].length > 0) {
      this.stacks[1].push(/** @type {T}*/ (this.stacks[0].pop()));
    }
  }
}

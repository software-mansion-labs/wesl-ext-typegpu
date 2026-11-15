export class Queue<T> {
  stacks: [T[], T[]];

  constructor(initialElements: Array<T>) {
    this.stacks = [initialElements, []];
  }

  add(elem: T): void {
    this.stacks[0].push(elem);
  }

  remove(): T | undefined {
    if (this.stacks[1].length === 0) {
      this.#relocate();
    }
    return this.stacks[1].pop();
  }

  get length(): number {
    return this.stacks[0].length + this.stacks[1].length;
  }

  #relocate() {
    while (this.stacks[0].length > 0) {
      const elem = this.stacks[0].pop() as T;
      this.stacks[1].push(elem);
    }
  }
}

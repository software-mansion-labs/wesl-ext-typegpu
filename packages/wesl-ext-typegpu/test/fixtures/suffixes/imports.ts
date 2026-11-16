// Typechecked by test/suffixes.test.ts against suffixes.d.ts (see tsconfig.json).
// The imported files don't exist, so these resolve only through its ambient
// module declarations.

import { Plain } from './shader.wesl?typegpu';
import { Condition } from './shader.wesl?DEBUG&typegpu';
import { Conditions } from './shader.wesl?DEBUG&LIGHTS=false&typegpu';
import { Explicit } from './shader.wesl?DEBUG=true&typegpu';
// Ambient module patterns allow a single `*`, so `typegpu` can't be matched
// in the middle of the query.
// @ts-expect-error
import { ConditionAfter } from './shader.wesl?typegpu&DEBUG';
// Imports for other extensions aren't covered.
// @ts-expect-error
import { Link } from './shader.wesl?link';

export const imports: unknown[] = [
  Plain,
  Condition,
  Conditions,
  Explicit,
  ConditionAfter,
  Link,
];

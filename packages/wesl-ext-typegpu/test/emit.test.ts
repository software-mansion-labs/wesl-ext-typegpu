import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { parseSync } from 'vite';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { link, RecordResolver, type WeslBundle } from 'wesl';
import type { PluginExtensionApi } from 'wesl-plugin';

import { typegpuExtension } from '../src/index.ts';

/**
 * Runs the extension the same way wesl-plugin would for `import ... from '<weslRoot>/<modulePath>?typegpu'`,
 * but against an in-memory set of sources (keyed by path relative to the wesl root) instead of a bundler context.
 */
async function emit(
  weslSrc: Record<string, string>,
  modulePath = 'main.wesl',
  projectDir = '/nonexistent',
): Promise<string> {
  const registry = new RecordResolver(weslSrc);
  const api = {
    weslMain: async () => modulePath,
    weslRegistry: async () => registry,
    weslToml: async () =>
      ({ tomlDir: projectDir }) as Awaited<
        ReturnType<PluginExtensionApi['weslToml']>
      >,
  } as Partial<PluginExtensionApi> as PluginExtensionApi;

  return typegpuExtension.emitFn(modulePath, api);
}

/**
 * Emits the module and returns the located error that the placeholder for
 * the untranslatable declaration `name` throws when it's used.
 */
async function untranslatableMessage(
  weslSrc: Record<string, string>,
  name: string,
): Promise<string> {
  const code = await emit(weslSrc);
  const match = code.match(
    new RegExp(
      `^export const ${name} = /\\* @__PURE__ \\*/ \\$untranslatable\\((".*")\\);$`,
      'm',
    ),
  );
  if (!match) {
    throw new Error(`'${name}' was not emitted as untranslatable:\n${code}`);
  }
  return JSON.parse(match[1] as string);
}

// Untranslatable declarations are reported with `console.warn`, keep the test output clean.
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

const structs = `
struct StructA { a: vec3f }
struct StructB { a: vec3f }
struct StructC { a: vec3f }
struct StructD { a: vec3f }
struct StructE { a: vec3f }
struct StructF { a: vec3f }
fn function_to_ignore() -> vec2f { return vec2f(1.0, 0.0); }
`;

const nestedStructs = `
struct NestedStructA { a: vec3f }
struct NestedStructB { a: vec3f }
struct NestedStructC { a: vec3f }
struct NestedStructD { a: vec3f }
struct NestedStructE { a: vec3f }
`;

describe('structs', () => {
  it('emits only the typegpu/data import for a module without structs', async () => {
    expect(
      await emit({ 'main.wesl': 'fn main() -> f32 { return 1.0; }' }),
    ).toMatchInlineSnapshot(`"import * as d from 'typegpu/data';"`);
  });

  it('translates field types', async () => {
    expect(
      await emit({
        'main.wesl': `
          struct Types {
            standardType: vec3f,
            standardUnwrappedType: vec3<f32>,
            arrayWithLengthType: array<vec4f, 3>,
            atomicType: atomic<u32>,
            uniformPointerType: ptr<uniform, array<f32, 4>, read_write>,
            storagePointerType: ptr<storage, array<f32, 4>, read_write>,
          }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Types = d.struct({
        standardType: d.vec3f,
        standardUnwrappedType: d.vec3f,
        arrayWithLengthType: d.arrayOf(d.vec4f, 3),
        atomicType: d.atomic(d.u32),
        uniformPointerType: d.ptrUniform(d.arrayOf(d.f32, 4)),
        storagePointerType: d.ptrStorage(d.arrayOf(d.f32, 4), "read-write")
      }).$name("Types");"
    `);
  });

  it('translates matrix types', async () => {
    expect(
      await emit({
        'main.wesl': `
          struct Matrices {
            a: mat2x2<f32>,
            b: mat3x3<f32>,
            c: mat4x4<f32>,
            d: mat4x4f,
            e: array<mat3x3<f32>, 2>,
          }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Matrices = d.struct({
        a: d.mat2x2f,
        b: d.mat3x3f,
        c: d.mat4x4f,
        d: d.mat4x4f,
        e: d.arrayOf(d.mat3x3f, 2)
      }).$name("Matrices");"
    `);
  });

  it.each([
    ['mat2x3<f32>', "Matrix type 'mat2x3<f32>' is not supported by TypeGPU"],
    ['mat4x4<f16>', "Matrix type 'mat4x4<f16>' is not supported by TypeGPU"],
    ['mat3x4f', "Matrix type 'mat3x4f' is not supported by TypeGPU"],
    ['mat2x2h', "Matrix type 'mat2x2h' is not supported by TypeGPU"],
    ['mat4x4<u32>', "Unsupported matrix parameters for 'mat4x4'"],
  ])('reports the unsupported matrix type %s', async (type, message) => {
    expect(
      await untranslatableMessage(
        { 'main.wesl': `struct X { a: ${type} }` },
        'X',
      ),
    ).toContain(message);
  });

  it('translates field attributes', async () => {
    expect(
      await emit({
        'main.wesl': `
          struct Inner { a: vec3f }

          struct Attributes {
            @align(16+16) alignedAttribute: Inner,
            @size(16) sizedAttribute: Inner,
            @location(0) locationAttribute: vec3f,
            @interpolate(flat) interpolateAttribute: vec3f,
            @interpolate(linear, center) interpolateTwoParamsAttribute: vec3f,
            @builtin(position) builtinType: vec4f,
            @location(1) @interpolate(perspective, sample) @size(32) @align(16) chainedAttributes: vec4f,
          }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Inner = d.struct({
        a: d.vec3f
      }).$name("Inner");
      export const Attributes = d.struct({
        alignedAttribute: d.align(16 + 16, Inner),
        sizedAttribute: d.size(16, Inner),
        locationAttribute: d.location(0, d.vec3f),
        interpolateAttribute: d.interpolate("flat", d.vec3f),
        interpolateTwoParamsAttribute: d.interpolate("linear, center", d.vec3f),
        builtinType: d.builtin.position,
        chainedAttributes: d.location(1, d.interpolate("perspective, sample", d.size(32, d.align(16, d.vec4f))))
      }).$name("Attributes");"
    `);
  });

  it('applies @invariant to @builtin regardless of attribute order', async () => {
    expect(
      await emit({
        'main.wesl': `
          struct Out {
            @invariant @builtin(position) invariantFirst: vec4f,
            @builtin(position) @invariant builtinFirst: vec4f,
          }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Out = d.struct({
        invariantFirst: d.invariant(d.builtin.position),
        builtinFirst: d.invariant(d.builtin.position)
      }).$name("Out");"
    `);
  });

  it('translates every builtin value', async () => {
    expect(
      await emit({
        'main.wesl': `
          struct Builtins {
            @builtin(clip_distances) clipDistances: array<f32, 8>,
            @builtin(frag_depth) fragDepth: f32,
            @builtin(front_facing) frontFacing: bool,
            @builtin(global_invocation_id) globalInvocationId: vec3u,
            @builtin(global_invocation_index) globalInvocationIndex: u32,
            @builtin(instance_index) instanceIndex: u32,
            @builtin(local_invocation_id) localInvocationId: vec3u,
            @builtin(local_invocation_index) localInvocationIndex: u32,
            @builtin(num_subgroups) numSubgroups: u32,
            @builtin(num_workgroups) numWorkgroups: vec3u,
            @builtin(position) position: vec4f,
            @builtin(primitive_index) primitiveIndex: u32,
            @builtin(sample_index) sampleIndex: u32,
            @builtin(sample_mask) sampleMask: u32,
            @builtin(subgroup_id) subgroupId: u32,
            @builtin(subgroup_invocation_id) subgroupInvocationId: u32,
            @builtin(subgroup_size) subgroupSize: u32,
            @builtin(vertex_index) vertexIndex: u32,
            @builtin(workgroup_id) workgroupId: vec3u,
            @builtin(workgroup_index) workgroupIndex: u32,
          }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Builtins = d.struct({
        clipDistances: d.builtin.clipDistances,
        fragDepth: d.builtin.fragDepth,
        frontFacing: d.builtin.frontFacing,
        globalInvocationId: d.builtin.globalInvocationId,
        globalInvocationIndex: d.builtin.globalInvocationIndex,
        instanceIndex: d.builtin.instanceIndex,
        localInvocationId: d.builtin.localInvocationId,
        localInvocationIndex: d.builtin.localInvocationIndex,
        numSubgroups: d.builtin.numSubgroups,
        numWorkgroups: d.builtin.numWorkgroups,
        position: d.builtin.position,
        primitiveIndex: d.builtin.primitiveIndex,
        sampleIndex: d.builtin.sampleIndex,
        sampleMask: d.builtin.sampleMask,
        subgroupId: d.builtin.subgroupId,
        subgroupInvocationId: d.builtin.subgroupInvocationId,
        subgroupSize: d.builtin.subgroupSize,
        vertexIndex: d.builtin.vertexIndex,
        workgroupId: d.builtin.workgroupId,
        workgroupIndex: d.builtin.workgroupIndex
      }).$name("Builtins");"
    `);
  });

  it('reports attributes without a TypeGPU counterpart', async () => {
    expect(
      await untranslatableMessage(
        {
          'main.wesl': `
          struct Out {
            @blend_src(0) @location(0) color: vec4f,
          }
        `,
        },
        'Out',
      ),
    ).toMatchInlineSnapshot(
      `"./main.wesl:3:13: Cannot translate struct 'Out', member 'color': Attribute @blend_src is not supported by TypeGPU in '@blend_src(0)'"`,
    );
  });

  it('reports builtin values without a TypeGPU counterpart', async () => {
    expect(
      await untranslatableMessage(
        {
          'main.wesl': `
          struct In {
            @builtin(not_a_builtin) value: u32,
          }
        `,
        },
        'In',
      ),
    ).toMatchInlineSnapshot(
      `"./main.wesl:3:13: Cannot translate struct 'In', member 'value': Builtin value not_a_builtin is not supported by TypeGPU in '@builtin(not_a_builtin)'"`,
    );
  });

  it('translates struct attributes', async () => {
    expect(
      await emit({
        'main.wesl': `
          @location(0) struct Located { a: vec3f }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Located = d.location(0, d.struct({
        a: d.vec3f
      }).$name("Located"));"
    `);
  });

  it('orders structs so that dependencies are defined first', async () => {
    expect(
      await emit({
        'main.wesl': `
          struct DefinedAbove { a: vec3f }

          struct Dependent {
            definedAboveType: DefinedAbove,
            definedBelowType: DefinedBelow,
            definedBelowInArrayType: array<array<DefinedBelowInArray, 4>, 2>,
          }

          struct DefinedBelow { b: vec3f }
          struct DefinedBelowInArray { c: vec3f }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const DefinedAbove = d.struct({
        a: d.vec3f
      }).$name("DefinedAbove");
      export const DefinedBelow = d.struct({
        b: d.vec3f
      }).$name("DefinedBelow");
      export const DefinedBelowInArray = d.struct({
        c: d.vec3f
      }).$name("DefinedBelowInArray");
      export const Dependent = d.struct({
        definedAboveType: DefinedAbove,
        definedBelowType: DefinedBelow,
        definedBelowInArrayType: d.arrayOf(d.arrayOf(DefinedBelowInArray, 4), 2)
      }).$name("Dependent");"
    `);
  });

  it('turns runtime-sized structs into functions of the array length', async () => {
    expect(
      await emit({
        'main.wesl': `
          struct RuntimeSized { d: array<f32> }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const RuntimeSized = (__arrayLength => d.struct({
        d: d.arrayOf(d.f32, __arrayLength)
      }).$name("RuntimeSized"));"
    `);
  });
});

describe('aliases', () => {
  it('emits aliases as exported constants', async () => {
    expect(
      await emit({
        'main.wesl': `
          alias Vec = vec3f;
          alias Arr = array<vec4<f32>, 4>;
          struct X { a: Vec, b: Arr }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Vec = d.vec3f;
      export const Arr = d.arrayOf(d.vec4f, 4);
      export const X = d.struct({
        a: Vec,
        b: Arr
      }).$name("X");"
    `);
  });

  it('orders structs and aliases together by dependency', async () => {
    expect(
      await emit({
        'main.wesl': `
          struct Outer { inner: InnerAlias, list: ListAlias }
          alias ListAlias = array<AliasOfAlias, 2>;
          alias AliasOfAlias = InnerAlias;
          alias InnerAlias = Inner;
          struct Inner { a: f32 }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Inner = d.struct({
        a: d.f32
      }).$name("Inner");
      export const InnerAlias = Inner;
      export const AliasOfAlias = InnerAlias;
      export const ListAlias = d.arrayOf(AliasOfAlias, 2);
      export const Outer = d.struct({
        inner: InnerAlias,
        list: ListAlias
      }).$name("Outer");"
    `);
  });

  it('detects cycles going through aliases', async () => {
    await expect(
      emit({
        'main.wesl': `
          alias A = array<S, 2>;
          struct S { a: A }
        `,
      }),
    ).rejects.toThrow(/Cyclic dependency/);
  });

  it('turns runtime-sized array aliases and the structs using them into functions of the array length', async () => {
    expect(
      await emit({
        'main.wesl': `
          alias Arr = array<f32>;
          alias ArrOfArr = Arr;
          struct RuntimeSized { len: u32, data: Arr }
          struct RuntimeSizedNested { data: ArrOfArr }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Arr = (__arrayLength => d.arrayOf(d.f32, __arrayLength));
      export const RuntimeSized = (__arrayLength => d.struct({
        len: d.u32,
        data: Arr(__arrayLength)
      }).$name("RuntimeSized"));
      export const ArrOfArr = Arr;
      export const RuntimeSizedNested = (__arrayLength => d.struct({
        data: ArrOfArr(__arrayLength)
      }).$name("RuntimeSizedNested"));"
    `);
  });

  it('imports aliases from other modules', async () => {
    expect(
      await emit({
        'main.wesl': `
          import package::types::Vec;
          import package::types;

          alias LocalVec = types::Vec;
          struct X { a: Vec, b: LocalVec }
        `,
        'types.wesl': 'alias Vec = vec3f;',
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { Vec, Vec as types$Vec } from './types.wesl?typegpu';
      export const LocalVec = types$Vec;
      export const X = d.struct({
        a: Vec,
        b: LocalVec
      }).$name("X");"
    `);
  });

  it('emits a module that only declares aliases', async () => {
    expect(
      await emit(
        {
          'types.wesl': `
            alias Vec = vec3f;
            alias Runtime = array<Vec>;
          `,
        },
        'types.wesl',
      ),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Vec = d.vec3f;
      export const Runtime = (__arrayLength => d.arrayOf(Vec, __arrayLength));"
    `);
  });
});

describe('expressions', () => {
  it('translates array lengths and attribute arguments into JS', async () => {
    expect(
      await emit({
        'main.wesl': `
          const MAX_COUNT = 4;
          struct X {
            a: array<f32, MAX_COUNT>,
            b: array<f32, 4u>,
            @align(MAX_COUNT) c: f32,
            @location(1u) d: f32,
            e: array<f32, 0x10i>,
          }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const MAX_COUNT = 4;
      export const X = d.struct({
        a: d.arrayOf(d.f32, MAX_COUNT),
        b: d.arrayOf(d.f32, 4),
        c: d.align(MAX_COUNT, d.f32),
        d: d.location(1, d.f32),
        e: d.arrayOf(d.f32, 0x10)
      }).$name("X");"
    `);
  });

  it('translates arithmetic', async () => {
    expect(
      await emit({
        'main.wesl': `
          const N = 3;
          struct X {
            a: array<f32, (N + 1) * 2 - -1>,
            b: array<f32, 7 / 2>,
            c: array<f32, (N << 1u) | 1>,
            d: array<f32, ~(-8) % 5>,
          }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const N = 3;
      export const X = d.struct({
        a: d.arrayOf(d.f32, (N + 1) * 2 - -1),
        b: d.arrayOf(d.f32, Math.trunc(7 / 2)),
        c: d.arrayOf(d.f32, (N << 1) | 1),
        d: d.arrayOf(d.f32, ~(-8) % 5)
      }).$name("X");"
    `);
  });

  it('translates WGSL literals into JS literals', async () => {
    expect(
      await emit({
        'main.wesl': `
          const DEC_INT = 12;
          const I32 = 3i;
          const U32 = 4u;
          const HEX_INT = 0x1Fu;
          const FLOAT = 2.0f;
          const HALF = 1h;
          const DOT_FLOAT = 1.;
          const LEADING_DOT = .5;
          const EXPONENT = 1e3f;
          const HEX_FLOAT = 0x1.8p1;
          const HEX_FLOAT_SUFFIX = 0xAp-1h;
          const BOOL = true;
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const DEC_INT = 12;
      export const I32 = 3;
      export const U32 = 4;
      export const HEX_INT = 0x1F;
      export const FLOAT = 2;
      export const HALF = 1;
      export const DOT_FLOAT = 1;
      export const LEADING_DOT = 0.5;
      export const EXPONENT = 1000;
      export const HEX_FLOAT = 3;
      export const HEX_FLOAT_SUFFIX = 5;
      export const BOOL = true;"
    `);
  });

  it('emits consts ordered before their users and skips untranslatable unused consts', async () => {
    expect(
      await emit({
        'main.wesl': `
          const DOUBLED = BASE * 2;
          const UNUSED_VECTOR = vec3f(1.0);
          const BASE = 3;
          struct X { a: array<f32, DOUBLED> }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const BASE = 3;
      export const DOUBLED = BASE * 2;
      export const X = d.struct({
        a: d.arrayOf(d.f32, DOUBLED)
      }).$name("X");"
    `);
  });

  it('reports a length that is not translatable, naming the struct and member', async () => {
    expect(
      await untranslatableMessage(
        {
          'main.wesl': `
          struct X { a: array<f32, max(1, 2)> }
        `,
        },
        'X',
      ),
    ).toMatchInlineSnapshot(
      `"./main.wesl:2:36: Cannot translate struct 'X', member 'a': function calls ('max(...)') are not supported in 'max(1, 2)'"`,
    );
  });

  it('reports an attribute argument that depends on an untranslatable const', async () => {
    expect(
      await untranslatableMessage(
        {
          'main.wesl': `
          const SIZE = max(16, 32);
          struct X { @size(SIZE) a: f32 }
        `,
        },
        'X',
      ),
    ).toMatchInlineSnapshot(
      `"./main.wesl:3:28: Cannot translate struct 'X', member 'a': const 'SIZE' cannot be translated: function calls ('max(...)') are not supported in 'SIZE'"`,
    );
  });

  it('reports a struct attribute that references something that is not a const', async () => {
    expect(
      await untranslatableMessage(
        {
          'main.wesl': `
          override LOC: u32;
          @location(LOC) struct X { a: f32 }
        `,
        },
        'X',
      ),
    ).toMatchInlineSnapshot(
      `"./main.wesl:3:21: Cannot translate struct 'X': 'LOC' does not refer to a const in 'LOC'"`,
    );
  });

  it('translates lengths in aliases and names the alias when they are not translatable', async () => {
    expect(
      await emit({
        'main.wesl': `
          const N = 2u;
          alias Arr = array<f32, N * 2>;
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const N = 2;
      export const Arr = d.arrayOf(d.f32, N * 2);"
    `);
    expect(
      await untranslatableMessage(
        { 'main.wesl': `alias Arr = array<f32, max(1, 2)>;` },
        'Arr',
      ),
    ).toMatchInlineSnapshot(
      `"./main.wesl:1:24: Cannot translate alias 'Arr': function calls ('max(...)') are not supported in 'max(1, 2)'"`,
    );
  });

  it('imports consts used in lengths, attributes and other consts', async () => {
    const sources = {
      'main.wesl': `
        import package::consts::{SIZE, ALIGN, BASE};
        const LOCAL = BASE + 1;
        struct X {
          a: array<f32, SIZE>,
          @align(ALIGN) b: f32,
          c: array<f32, LOCAL>,
          d: array<f32, package::consts::INLINE * 2>,
        }
      `,
      'consts.wesl': `
        const SIZE = 4u;
        const ALIGN = SIZE * 4;
        const BASE = 2;
        const INLINE = 8;
      `,
    };
    expect(await emit(sources)).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { ALIGN, BASE, INLINE as package$consts$INLINE, SIZE } from './consts.wesl?typegpu';
      export const LOCAL = BASE + 1;
      export const X = d.struct({
        a: d.arrayOf(d.f32, SIZE),
        b: d.align(ALIGN, d.f32),
        c: d.arrayOf(d.f32, LOCAL),
        d: d.arrayOf(d.f32, package$consts$INLINE * 2)
      }).$name("X");"
    `);
    expect(await emit(sources, 'consts.wesl')).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const SIZE = 4;
      export const ALIGN = SIZE * 4;
      export const BASE = 2;
      export const INLINE = 8;"
    `);
  });
});

describe('imports', () => {
  it('imports only the structs used by struct fields', async () => {
    expect(
      await emit({
        'main.wesl': `
          import bevy_pbr::forward_io::ImportToIgnore;
          import package::structs::StructA;
          import package::structs::{StructB, function_to_ignore};
          import package::folder::nestedStructs::NestedStructA;
          import package::structs::StructC as StructCAlias;

          struct Imports {
            imported: StructA,
            importedFromTree: StructB,
            importedNested: NestedStructA,
            importedAlias: StructCAlias,
          }
        `,
        'structs.wesl': structs,
        'folder/nestedStructs.wesl': nestedStructs,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { NestedStructA } from './folder/nestedStructs.wesl?typegpu';
      import { StructA, StructB, StructC as StructCAlias } from './structs.wesl?typegpu';
      export const Imports = d.struct({
        imported: StructA,
        importedFromTree: StructB,
        importedNested: NestedStructA,
        importedAlias: StructCAlias
      }).$name("Imports");"
    `);
  });

  it('imports structs referenced by inline paths', async () => {
    expect(
      await emit({
        'main.wesl': `
          import package::structs;
          import package::folder::nestedStructs;
          import package::structs as ModuleAlias;
          import package::folder as FolderAlias;
          import package::folder::nestedStructs as NestedAlias;

          struct InlinedImports {
            inlinedDirectlyFromPackage: package::structs::StructD,
            inlinedNestedDirectlyFromPackage: package::folder::nestedStructs::NestedStructB,
            inlinedModule: structs::StructE,
            inlinedNestedModule: nestedStructs::NestedStructC,
            inlinedAlias: ModuleAlias::StructF,
            inlinedFolderAlias: FolderAlias::nestedStructs::NestedStructD,
            inlinedNestedAlias: NestedAlias::NestedStructE,
          }
        `,
        'structs.wesl': structs,
        'folder/nestedStructs.wesl': nestedStructs,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { NestedStructB as package$folder$nestedStructs$NestedStructB, NestedStructC as nestedStructs$NestedStructC, NestedStructD as FolderAlias$nestedStructs$NestedStructD, NestedStructE as NestedAlias$NestedStructE } from './folder/nestedStructs.wesl?typegpu';
      import { StructD as package$structs$StructD, StructE as structs$StructE, StructF as ModuleAlias$StructF } from './structs.wesl?typegpu';
      export const InlinedImports = d.struct({
        inlinedDirectlyFromPackage: package$structs$StructD,
        inlinedNestedDirectlyFromPackage: package$folder$nestedStructs$NestedStructB,
        inlinedModule: structs$StructE,
        inlinedNestedModule: nestedStructs$NestedStructC,
        inlinedAlias: ModuleAlias$StructF,
        inlinedFolderAlias: FolderAlias$nestedStructs$NestedStructD,
        inlinedNestedAlias: NestedAlias$NestedStructE
      }).$name("InlinedImports");"
    `);
  });

  it('merges imports from the same module into one sorted statement', async () => {
    expect(
      await emit({
        'main.wesl': `
          import package::structs::StructC;
          import package::folder::nestedStructs::NestedStructA;
          import package::structs::{StructB, StructA as Aliased};

          struct First {
            c: StructC,
            nested: NestedStructA,
            inlined: package::structs::StructD,
          }

          struct Second {
            c: StructC,
            b: StructB,
            a: Aliased,
          }
        `,
        'structs.wesl': structs,
        'folder/nestedStructs.wesl': nestedStructs,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { NestedStructA } from './folder/nestedStructs.wesl?typegpu';
      import { StructA as Aliased, StructB, StructC, StructD as package$structs$StructD } from './structs.wesl?typegpu';
      export const First = d.struct({
        c: StructC,
        nested: NestedStructA,
        inlined: package$structs$StructD
      }).$name("First");
      export const Second = d.struct({
        c: StructC,
        b: StructB,
        a: Aliased
      }).$name("Second");"
    `);
  });
});

/**
 * Asserts that every `?typegpu` specifier in the emitted code, resolved relative to the
 * emitted module's directory like a bundler would, points at one of the given sources.
 */
function expectImportsToResolve(
  code: string,
  weslSrc: Record<string, string>,
  modulePath: string,
) {
  const specifiers = [...code.matchAll(/from '(.*)\?typegpu'/g)].map(
    (m) => m[1] as string,
  );
  expect(specifiers.length).toBeGreaterThan(0);
  for (const specifier of specifiers) {
    const resolved = posix.join(posix.dirname(modulePath), specifier);
    expect(Object.keys(weslSrc)).toContain(resolved);
  }
}

describe('import paths', () => {
  it('resolves the first super:: to the directory of the module', async () => {
    const weslSrc = {
      'folder/main.wesl': `
        import super::structs::StructA;

        struct ImportFromSibling { importedFromSibling: StructA }
      `,
      'folder/structs.wesl': structs,
    };
    // the WESL linker agrees on where super:: points
    await expect(
      link({
        weslSrc: {
          ...weslSrc,
          'folder/main.wesl': `${weslSrc['folder/main.wesl']}
            @compute @workgroup_size(1) fn main() { let s = StructA(vec3f()); }`,
        },
        rootModuleName: 'folder/main.wesl',
      }),
    ).resolves.toBeDefined();

    const code = await emit(weslSrc, 'folder/main.wesl');
    expectImportsToResolve(code, weslSrc, 'folder/main.wesl');
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { StructA } from './structs.wesl?typegpu';
      export const ImportFromSibling = d.struct({
        importedFromSibling: StructA
      }).$name("ImportFromSibling");"
    `);
  });

  it('resolves each further super:: one directory up', async () => {
    const weslSrc = {
      'a/b/main.wesl': `
        import super::super::structs::StructA;
        import super::super::super::structs::StructB;

        struct ImportFromParents {
          fromParent: StructA,
          fromGrandparent: StructB,
          inlinedFromSibling: super::sibling::NestedStructA,
        }
      `,
      'a/b/sibling.wesl': nestedStructs,
      'a/structs.wesl': structs,
      'structs.wesl': structs,
    };
    const code = await emit(weslSrc, 'a/b/main.wesl');
    expectImportsToResolve(code, weslSrc, 'a/b/main.wesl');
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { StructB } from '../../structs.wesl?typegpu';
      import { StructA } from '../structs.wesl?typegpu';
      import { NestedStructA as super$sibling$NestedStructA } from './sibling.wesl?typegpu';
      export const ImportFromParents = d.struct({
        fromParent: StructA,
        fromGrandparent: StructB,
        inlinedFromSibling: super$sibling$NestedStructA
      }).$name("ImportFromParents");"
    `);
  });

  it('resolves package:: against the WESL root from a nested module', async () => {
    const weslSrc = {
      'a/b/main.wesl': `
        import package::structs::StructA;
        import package::a::b::sibling::NestedStructA;
        import package::a::other::NestedStructB;

        struct ImportFromPackage {
          fromRoot: StructA,
          fromSibling: NestedStructA,
          fromCousin: NestedStructB,
          inlinedFromRoot: package::structs::StructB,
          inlinedFromCousin: package::a::other::NestedStructC,
        }
      `,
      'structs.wesl': structs,
      'a/b/sibling.wesl': nestedStructs,
      'a/other.wesl': nestedStructs,
    };
    const code = await emit(weslSrc, 'a/b/main.wesl');
    expectImportsToResolve(code, weslSrc, 'a/b/main.wesl');
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { StructA, StructB as package$structs$StructB } from '../../structs.wesl?typegpu';
      import { NestedStructB, NestedStructC as package$a$other$NestedStructC } from '../other.wesl?typegpu';
      import { NestedStructA } from './sibling.wesl?typegpu';
      export const ImportFromPackage = d.struct({
        fromRoot: StructA,
        fromSibling: NestedStructA,
        fromCousin: NestedStructB,
        inlinedFromRoot: package$structs$StructB,
        inlinedFromCousin: package$a$other$NestedStructC
      }).$name("ImportFromPackage");"
    `);
  });

  it('keeps separators in nested import trees', async () => {
    const weslSrc = {
      'main.wesl': `
        import package::{structs::StructA, folder::{nested::{NestedStructA}}};
        import super::{structs::{StructB}};

        struct ImportFromTrees {
          a: StructA,
          b: StructB,
          nested: NestedStructA,
        }
      `,
      'structs.wesl': structs,
      'folder/nested.wesl': nestedStructs,
    };
    const code = await emit(weslSrc);
    expectImportsToResolve(code, weslSrc, 'main.wesl');
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { NestedStructA } from './folder/nested.wesl?typegpu';
      import { StructA, StructB } from './structs.wesl?typegpu';
      export const ImportFromTrees = d.struct({
        a: StructA,
        b: StructB,
        nested: NestedStructA
      }).$name("ImportFromTrees");"
    `);
  });

  it('does not rewrite segments that merely contain package or super', async () => {
    const weslSrc = {
      'main.wesl': `
        import package::my_package::supersample as superalias;

        struct Lookalikes {
          inlined: package::my_package::supersample::NestedStructA,
          aliased: superalias::NestedStructB,
        }
      `,
      'my_package/supersample.wesl': nestedStructs,
    };
    const code = await emit(weslSrc);
    expectImportsToResolve(code, weslSrc, 'main.wesl');
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { NestedStructA as package$my_package$supersample$NestedStructA, NestedStructB as superalias$NestedStructB } from './my_package/supersample.wesl?typegpu';
      export const Lookalikes = d.struct({
        inlined: package$my_package$supersample$NestedStructA,
        aliased: superalias$NestedStructB
      }).$name("Lookalikes");"
    `);
  });

  it('rejects super:: paths that go above the WESL root', async () => {
    await expect(
      emit({
        'main.wesl': `
          import super::super::structs::StructA;
          struct S { a: StructA }
        `,
      }),
    ).rejects.toThrow(/goes above the WESL root/);
  });
});

describe('identifier collisions', () => {
  /** Emits the module and checks that it is valid JS, including duplicate and strict mode bindings. */
  async function emitValid(
    weslSrc: Record<string, string>,
    modulePath?: string,
  ): Promise<string> {
    const code = await emit(weslSrc, modulePath);
    const { errors } = parseSync('emitted.js', code, {
      sourceType: 'module',
      showSemanticErrors: true,
    });
    expect(errors.map((error) => error.message)).toEqual([]);
    return code;
  }

  it('renames the typegpu/data namespace when a struct is named d', async () => {
    expect(
      await emitValid({
        'main.wesl': `
          struct d { a: f32 }
          struct d_1 { a: f32 }
          struct X { v: d, w: d_1 }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d_2 from 'typegpu/data';
      export const d = d_2.struct({
        a: d_2.f32
      }).$name("d");
      export const d_1 = d_2.struct({
        a: d_2.f32
      }).$name("d_1");
      export const X = d_2.struct({
        v: d,
        w: d_1
      }).$name("X");"
    `);
  });

  it('renames the typegpu/data namespace when an import is aliased d', async () => {
    expect(
      await emitValid({
        'main.wesl': `
          import package::structs::StructA as d;

          struct X { v: d, w: vec3f }
        `,
        'structs.wesl': structs,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d_1 from 'typegpu/data';
      import { StructA as d } from './structs.wesl?typegpu';
      export const X = d_1.struct({
        v: d,
        w: d_1.vec3f
      }).$name("X");"
    `);
  });

  it('renames the array length parameter when a struct is named __arrayLength', async () => {
    expect(
      await emitValid({
        'main.wesl': `
          struct __arrayLength { a: f32 }
          struct RuntimeSized { v: __arrayLength, rest: array<f32> }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const __arrayLength = d.struct({
        a: d.f32
      }).$name("__arrayLength");
      export const RuntimeSized = (__arrayLength_1 => d.struct({
        v: __arrayLength,
        rest: d.arrayOf(d.f32, __arrayLength_1)
      }).$name("RuntimeSized"));"
    `);
  });

  it('renames structs whose names are reserved in JS', async () => {
    expect(
      await emitValid({
        'main.wesl': `
          struct in { a: f32 }
          struct in_ { a: f32 }
          struct eval { a: f32 }
          struct X { v: in, w: in_, u: eval, arguments: f32 }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      const in__1 = d.struct({
        a: d.f32
      }).$name("in");
      export { in__1 as in };
      export const in_ = d.struct({
        a: d.f32
      }).$name("in_");
      const eval_ = d.struct({
        a: d.f32
      }).$name("eval");
      export { eval_ as eval };
      export const X = d.struct({
        v: in__1,
        w: in_,
        u: eval_,
        arguments: d.f32
      }).$name("X");"
    `);
  });

  it('renames imports whose names are reserved in JS', async () => {
    expect(
      await emitValid({
        'main.wesl': `
          import package::reserved::function;
          import package::reserved::private as void;

          struct X { v: function, w: void, u: package::reserved::arguments }
        `,
        'reserved.wesl': `
          struct function { a: f32 }
          struct private { a: f32 }
          struct arguments { a: f32 }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { arguments as package$reserved$arguments, function as function_, private as void_ } from './reserved.wesl?typegpu';
      export const X = d.struct({
        v: function_,
        w: void_,
        u: package$reserved$arguments
      }).$name("X");"
    `);
  });

  it('renames consts whose names are reserved in JS', async () => {
    expect(
      await emitValid({
        'main.wesl': `
          const in = 4;
          const d = in * 2;
          struct X { v: array<f32, d> }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d_1 from 'typegpu/data';
      const in_ = 4;
      export { in_ as in };
      export const d = in_ * 2;
      export const X = d_1.struct({
        v: d_1.arrayOf(d_1.f32, d)
      }).$name("X");"
    `);
  });

  it('renames aliases whose names collide or are reserved in JS', async () => {
    expect(
      await emitValid({
        'main.wesl': `
          alias d = f32;
          alias in = array<d>;
          struct X { v: in }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d_1 from 'typegpu/data';
      export const d = d_1.f32;
      const in_ = (__arrayLength => d_1.arrayOf(d, __arrayLength));
      export { in_ as in };
      export const X = (__arrayLength => d_1.struct({
        v: in_(__arrayLength)
      }).$name("X"));"
    `);
  });

  it('emits a valid module for structs with reserved names', async () => {
    await emitValid(
      {
        'reserved.wesl': `
          struct function { a: f32 }
          struct private { a: f32 }
          struct arguments { a: f32 }
        `,
      },
      'reserved.wesl',
    );
  });
});

/**
 * Evaluates emitted code without a bundler: imports are dropped and `d` is a stub
 * where every schema is a plain object, which is enough to observe which exports throw.
 */
function evaluate(code: string): Record<string, unknown> {
  const names = [...code.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
  const body = code
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n')
    .replaceAll('export const', 'const');
  const d = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'struct'
          ? (fields: object) => ({ $name: () => ({ fields }) })
          : `d.${String(key)}`,
    },
  );
  return new Function('d', `${body}\nreturn { ${names.join(', ')} };`)(d);
}

describe('errors', () => {
  it('emits the valid structs of a module next to a broken one', async () => {
    const code = await emit({
      'main.wesl': `
struct Fine { a: f32 }
struct X {
  ok: f32,
  v: vec3<MyT>,
}
`,
    });
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      const $untranslatable = (message) => new Proxy(function () {}, Object.fromEntries(['get', 'set', 'has', 'apply', 'construct', 'ownKeys', 'getOwnPropertyDescriptor', 'defineProperty', 'deleteProperty', 'getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions'].map((trap) => [trap, () => { throw new Error(message); }])));
      export const Fine = d.struct({
        a: d.f32
      }).$name("Fine");
      export const X = /* @__PURE__ */ $untranslatable("./main.wesl:5:6: Cannot translate struct 'X', member 'v': Unsupported vector parameters in 'vec3<MyT>'");"
    `);

    const exports = evaluate(code);
    expect(exports.Fine).toEqual({ fields: { a: 'd.f32' } });
    const message =
      "./main.wesl:5:6: Cannot translate struct 'X', member 'v': Unsupported vector parameters in 'vec3<MyT>'";
    // importing the broken struct is fine, using it in any way throws the located error
    const X = exports.X as Record<string, unknown> & (() => unknown);
    expect(() => X.someProperty).toThrow(message);
    expect(() => X()).toThrow(message);
    expect(() => Object.keys(X)).toThrow(message);
    expect(() => ({ ...X })).toThrow(message);
  });

  it('warns about broken structs at build time', async () => {
    await emit({
      'main.wesl': `
struct Fine { a: f32 }
struct X { v: vec3<MyT> }
`,
    });
    expect(warn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "[wesl-ext-typegpu] ./main.wesl:3:15: Cannot translate struct 'X', member 'v': Unsupported vector parameters in 'vec3<MyT>'",
        ],
      ]
    `);
  });

  it('locates errors from member and struct attributes', async () => {
    const code = await emit({
      'main.wesl': `
struct Diagnostic {
  @diagnostic(off, derivative_uniformity) a: f32,
}
@interpolate(flat, center, sample) struct Interpolated { a: f32 }
struct Pointer { p: ptr<nowhere, f32> }
`,
    });
    expect(code.split('\n').filter((l) => l.startsWith('export')))
      .toMatchInlineSnapshot(`
        [
          "export const Diagnostic = /* @__PURE__ */ $untranslatable("./main.wesl:3:3: Cannot translate struct 'Diagnostic', member 'a': Diagnostic attributes are not supported by TypeGPU in '@diagnostic(off, derivative_uniformity)'");",
          "export const Interpolated = /* @__PURE__ */ $untranslatable("./main.wesl:5:1: Cannot translate struct 'Interpolated': Invalid interpolation parameters in '@interpolate(flat, center, sample)'");",
          "export const Pointer = /* @__PURE__ */ $untranslatable("./main.wesl:6:25: Cannot translate struct 'Pointer', member 'p': Invalid ptr address space in 'nowhere'");",
        ]
      `);
  });

  it('marks structs that depend on a broken struct as broken, pointing at the root cause', async () => {
    const code = await emit({
      'main.wesl': `
struct Root { v: vec3<MyT> }
struct Middle { root: Root }
struct Top { list: array<Middle, 4> }
struct Unrelated { a: f32 }
`,
    });
    expect(code.split('\n').filter((l) => l.startsWith('export')))
      .toMatchInlineSnapshot(`
        [
          "export const Root = /* @__PURE__ */ $untranslatable("./main.wesl:2:18: Cannot translate struct 'Root', member 'v': Unsupported vector parameters in 'vec3<MyT>'");",
          "export const Unrelated = d.struct({",
          "export const Middle = /* @__PURE__ */ $untranslatable("./main.wesl:3:23: Cannot translate struct 'Middle', member 'root': depends on 'Root', which cannot be translated. Root cause: ./main.wesl:2:18: Cannot translate struct 'Root', member 'v': Unsupported vector parameters in 'vec3<MyT>'");",
          "export const Top = /* @__PURE__ */ $untranslatable("./main.wesl:4:20: Cannot translate struct 'Top', member 'list': depends on 'Middle', which cannot be translated. Root cause: ./main.wesl:2:18: Cannot translate struct 'Root', member 'v': Unsupported vector parameters in 'vec3<MyT>'");",
        ]
      `);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('propagates failures through aliases', async () => {
    const code = await emit({
      'main.wesl': `
alias BrokenAlias = vec3<MyT>;
struct UsesAlias { a: BrokenAlias }
struct Broken { v: vec3<MyT> }
alias AliasOfBroken = array<Broken, 2>;
alias Fine = vec3f;
`,
    });
    expect(code.split('\n').filter((l) => l.startsWith('export')))
      .toMatchInlineSnapshot(`
        [
          "export const Broken = /* @__PURE__ */ $untranslatable("./main.wesl:4:20: Cannot translate struct 'Broken', member 'v': Unsupported vector parameters in 'vec3<MyT>'");",
          "export const BrokenAlias = /* @__PURE__ */ $untranslatable("./main.wesl:2:21: Cannot translate alias 'BrokenAlias': Unsupported vector parameters in 'vec3<MyT>'");",
          "export const Fine = d.vec3f;",
          "export const AliasOfBroken = /* @__PURE__ */ $untranslatable("./main.wesl:5:23: Cannot translate alias 'AliasOfBroken': depends on 'Broken', which cannot be translated. Root cause: ./main.wesl:4:20: Cannot translate struct 'Broken', member 'v': Unsupported vector parameters in 'vec3<MyT>'");",
          "export const UsesAlias = /* @__PURE__ */ $untranslatable("./main.wesl:3:23: Cannot translate struct 'UsesAlias', member 'a': depends on 'BrokenAlias', which cannot be translated. Root cause: ./main.wesl:2:21: Cannot translate alias 'BrokenAlias': Unsupported vector parameters in 'vec3<MyT>'");",
        ]
      `);
  });

  it('does not emit imports used only by broken structs', async () => {
    const code = await emit({
      'main.wesl': `
import package::structs::{StructA, StructB};
struct Fine { a: StructA }
struct Broken { b: StructB, v: vec3<MyT> }
`,
      'structs.wesl': structs,
    });
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { StructA } from './structs.wesl?typegpu';
      const $untranslatable = (message) => new Proxy(function () {}, Object.fromEntries(['get', 'set', 'has', 'apply', 'construct', 'ownKeys', 'getOwnPropertyDescriptor', 'defineProperty', 'deleteProperty', 'getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions'].map((trap) => [trap, () => { throw new Error(message); }])));
      export const Fine = d.struct({
        a: StructA
      }).$name("Fine");
      export const Broken = /* @__PURE__ */ $untranslatable("./main.wesl:4:32: Cannot translate struct 'Broken', member 'v': Unsupported vector parameters in 'vec3<MyT>'");"
    `);
  });

  it('throws when the module cannot be resolved', async () => {
    await expect(
      emit({}, 'missing.wesl'),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[ModuleTranslationError: Unable to resolve WESL module 'package::missing' (missing.wesl), imported as 'missing.wesl']`,
    );
  });

  it('throws on cyclic struct dependencies, naming the structs in the cycle', async () => {
    await expect(
      emit({
        'main.wesl': `
struct Fine { a: f32 }
struct A { b: B }
struct B { c: array<C, 2> }
struct C { a: A }
struct DependsOnCycle { a: A }
`,
      }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[ModuleTranslationError: ./main.wesl:3:1: Cyclic dependency between types: A -> B -> C -> A]`,
    );
  });

  it('throws on self-referencing structs', async () => {
    await expect(
      emit({ 'main.wesl': 'struct Node { next: Node }' }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[ModuleTranslationError: ./main.wesl:1:1: Cyclic dependency between types: Node -> Node]`,
    );
  });
});

describe('library imports', () => {
  const mathModule = `
    import package::util::Inner;
    import other_lib::Remote;

    struct Foo { a: vec3f }
    struct Bar { inner: Inner, remote: Remote }
    alias FooAlias = Foo;
    const COUNT = 4;
  `;
  const lygia: WeslBundle = {
    name: 'lygia',
    edition: 'unstable_2025_1',
    modules: {
      'math.wesl': mathModule,
      'util.wesl': 'struct Inner { b: f32 }',
    },
  };
  const otherLib: WeslBundle = {
    name: 'other_lib',
    edition: 'unstable_2025_1',
    modules: { 'lib.wesl': 'struct Remote { c: u32 }' },
  };
  const scopedLib: WeslBundle = {
    name: 'scope__my_lib',
    edition: 'unstable_2025_1',
    modules: { 'shapes.wesl': 'struct Circle { r: f32 }' },
  };

  /** A project directory with the bundles installed as npm packages, the way wesl-packager publishes them. */
  let projectDir: string;
  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'wesl-ext-typegpu-'));
    const install = (npmName: string, bundle: WeslBundle) => {
      const dir = join(projectDir, 'node_modules', npmName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: npmName,
          type: 'module',
          exports: { '.': { import: './weslBundle.js' } },
        }),
      );
      writeFileSync(
        join(dir, 'weslBundle.js'),
        `export default ${JSON.stringify(bundle)};`,
      );
    };
    install('lygia', lygia);
    install('other-lib', otherLib);
    install('@scope/my-lib', scopedLib);
  });

  it('imports library structs from their virtual module path', async () => {
    const code = await emit(
      {
        'folder/main.wesl': `
          import lygia::math::Foo;
          import scope__my_lib::shapes;

          struct X { a: Foo, b: lygia::math::Bar, c: shapes::Circle }
        `,
      },
      'folder/main.wesl',
      projectDir,
    );
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { Bar as lygia$math$Bar, Foo } from '../__wesl_lib__/lygia/math.wesl?typegpu';
      import { Circle as shapes$Circle } from '../__wesl_lib__/scope__my_lib/shapes.wesl?typegpu';
      export const X = d.struct({
        a: Foo,
        b: lygia$math$Bar,
        c: shapes$Circle
      }).$name("X");"
    `);
  });

  it('emits the schemas of a library module', async () => {
    // the WESL linker agrees on what the library paths point to
    await expect(
      link({
        weslSrc: {
          'main.wesl': `
            import lygia::math::Bar;
            @compute @workgroup_size(1) fn main() { var b: Bar; }
          `,
        },
        rootModuleName: 'main.wesl',
        libs: [lygia, otherLib],
      }),
    ).resolves.toBeDefined();

    const code = await emit(
      {},
      '/project/shaders/__wesl_lib__/lygia/math.wesl',
      projectDir,
    );
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { Inner } from '^^/project/shaders/__wesl_lib__/lygia/util.wesl?typegpu';
      import { Remote } from '^^/project/shaders/__wesl_lib__/other_lib.wesl?typegpu';
      export const COUNT = 4;
      export const Foo = d.struct({
        a: d.vec3f
      }).$name("Foo");
      export const Bar = d.struct({
        inner: Inner,
        remote: Remote
      }).$name("Bar");
      export const FooAlias = Foo;"
    `);
  });

  it('emits the root module of a library', async () => {
    const code = await emit(
      {},
      '/project/shaders/__wesl_lib__/other_lib.wesl',
      projectDir,
    );
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      export const Remote = d.struct({
        c: d.u32
      }).$name("Remote");"
    `);
  });

  it('imports other library modules by their resolved id, wherever the library module was loaded from', async () => {
    // wesl-plugin hands extensions the path with its '^^' resolution prefix stripped once
    const code = await emit(
      {},
      '^^/project/shaders/__wesl_lib__/lygia/math.wesl',
      projectDir,
    );
    expect(code).toContain(
      "from '^^/project/shaders/__wesl_lib__/lygia/util.wesl?typegpu'",
    );
  });

  it('names the struct member when the library is missing', async () => {
    await expect(
      emit(
        {
          'main.wesl': `
            import missing_lib::math::Foo;
            struct X { a: Foo }
          `,
        },
        'main.wesl',
        projectDir,
      ),
    ).rejects.toThrow(
      "Unable to find the WESL library for module 'missing_lib::math' (used by struct member 'X.a'). Is the npm package 'missing_lib' installed?",
    );
  });

  it('names the struct member when the library has no such module', async () => {
    await expect(
      emit(
        { 'main.wesl': 'struct X { a: lygia::nope::Foo }' },
        'main.wesl',
        projectDir,
      ),
    ).rejects.toThrow(
      "WESL library 'lygia' has no module 'lygia::nope' (used by struct member 'X.a')",
    );
  });

  it('names the struct member when the library module has no such struct', async () => {
    await expect(
      emit(
        { 'main.wesl': 'struct X { a: lygia::math::Nope }' },
        'main.wesl',
        projectDir,
      ),
    ).rejects.toThrow(
      "WESL library module 'lygia::math' has no struct, alias or const 'Nope' (used by struct member 'X.a')",
    );
  });

  it('imports library consts used by array lengths', async () => {
    const code = await emit(
      {
        'main.wesl': `
          import lygia::math;
          struct X { a: array<f32, math::COUNT>, b: array<f32, lygia::math::COUNT> }
        `,
      },
      'main.wesl',
      projectDir,
    );
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { COUNT as lygia$math$COUNT, COUNT as math$COUNT } from './__wesl_lib__/lygia/math.wesl?typegpu';
      export const X = d.struct({
        a: d.arrayOf(d.f32, math$COUNT),
        b: d.arrayOf(d.f32, lygia$math$COUNT)
      }).$name("X");"
    `);
  });

  it('names the struct member when it uses a missing library const', async () => {
    await expect(
      emit(
        { 'main.wesl': 'struct X { a: array<f32, lygia::math::NOPE> }' },
        'main.wesl',
        projectDir,
      ),
    ).rejects.toThrow(
      "WESL library module 'lygia::math' has no struct, alias or const 'NOPE' (used by struct member 'X.a')",
    );
  });

  it('names the alias when it uses a missing library item', async () => {
    await expect(
      emit(
        { 'main.wesl': 'alias A = lygia::math::Nope;' },
        'main.wesl',
        projectDir,
      ),
    ).rejects.toThrow(
      "WESL library module 'lygia::math' has no struct, alias or const 'Nope' (used by alias 'A')",
    );
  });

  it('imports library types used by aliases, including library aliases', async () => {
    const code = await emit(
      {
        'main.wesl': `
          import lygia::math::FooAlias;
          alias A = lygia::math::Bar;
          struct X { a: FooAlias, b: A }
        `,
      },
      'main.wesl',
      projectDir,
    );
    expect(code).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { Bar as lygia$math$Bar, FooAlias } from './__wesl_lib__/lygia/math.wesl?typegpu';
      export const A = lygia$math$Bar;
      export const X = d.struct({
        a: FooAlias,
        b: A
      }).$name("X");"
    `);
  });
});

/**
 * Emits every module, then evaluates them as native ES modules in a separate Node process,
 * importing `entries` in the given order (as `m0`, `m1`, ...) before running `script`.
 * `typegpu/data` is replaced with a stub that keeps the fields of each struct,
 * so the result shows which schema objects ended up where.
 */
async function runEmitted(
  weslSrc: Record<string, string>,
  entries: string[],
  script: string,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wesl-ext-typegpu-'));
  try {
    writeFileSync(
      join(dir, 'typegpu-data.mjs'),
      `export const f32 = 'f32';
       export function arrayOf(element, length) { return { element, length }; }
       export function struct(fields) {
         return { fields, $name(name) { this.name = name; return this; } };
       }`,
    );
    for (const modulePath of Object.keys(weslSrc)) {
      const code = (await emit(weslSrc, modulePath))
        .replace(`'typegpu/data'`, `'./typegpu-data.mjs'`)
        .replaceAll(/\.wesl\?typegpu'/g, `.mjs'`);
      writeFileSync(join(dir, modulePath.replace('.wesl', '.mjs')), code);
    }
    const imports = entries
      .map((entry, i) => `import * as m${i} from './${entry}.mjs';`)
      .join('\n');
    writeFileSync(join(dir, 'entry.mjs'), `${imports}\n${script}`);
    return execFileSync(process.execPath, [join(dir, 'entry.mjs')], {
      encoding: 'utf8',
    }).trim();
  } finally {
    rmSync(dir, { recursive: true });
  }
}

describe('import cycles between modules', () => {
  // The modules import from each other, but the types themselves don't form a cycle
  const cyclicModules = {
    'a.wesl': `
      import package::b::B1;
      const N = 2;
      struct A1 { x: array<f32, N> }
      struct A2 { b: B1 }
      alias AliasOfB = B1;
    `,
    'b.wesl': `
      import package::a::A1 as Aliased;
      struct B1 { a: Aliased }
      struct B2 { a: package::a::A2, b: B1, c: package::a::AliasOfB }
    `,
  };

  it('emits declarations behind hoisted getters, reading the cycle through getters', async () => {
    expect(await emit(cyclicModules, 'a.wesl')).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { $get$B1 } from './b.wesl?typegpu';
      function $get$N() { return 2; }
      export const N = $get$N();
      export function $get$A1() {
        return A1 ??= d.struct({
        x: d.arrayOf(d.f32, $get$N())
      }).$name("A1");
      }
      export var A1 = $get$A1();
      export function $get$A2() {
        const B1 = $get$B1();
        return A2 ??= d.struct({
        b: B1
      }).$name("A2");
      }
      export var A2 = $get$A2();
      export function $get$AliasOfB() {
        const B1 = $get$B1();
        return AliasOfB ??= B1;
      }
      export var AliasOfB = $get$AliasOfB();"
    `);
    expect(await emit(cyclicModules, 'b.wesl')).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { $get$A1 as $get$Aliased, $get$A2 as $get$package$a$A2, $get$AliasOfB as $get$package$a$AliasOfB } from './a.wesl?typegpu';
      export function $get$B1() {
        const Aliased = $get$Aliased();
        return B1 ??= d.struct({
        a: Aliased
      }).$name("B1");
      }
      export var B1 = $get$B1();
      export function $get$B2() {
        const B1 = $get$B1();
        const package$a$A2 = $get$package$a$A2();
        const package$a$AliasOfB = $get$package$a$AliasOfB();
        return B2 ??= d.struct({
        a: package$a$A2,
        b: B1,
        c: package$a$AliasOfB
      }).$name("B2");
      }
      export var B2 = $get$B2();"
    `);
  });

  it.each([
    ['a', 'b'],
    ['b', 'a'],
  ])(
    'evaluates as native ES modules when %s is imported first',
    async (...entries) => {
      const [a, b] = entries[0] === 'a' ? ['m0', 'm1'] : ['m1', 'm0'];
      const output = await runEmitted(
        cyclicModules,
        entries,
        `const { A1, A2, AliasOfB } = ${a};
         const { B1, B2 } = ${b};
         console.log(JSON.stringify({
           A1length: A1.fields.x.length,
           A2usesB1: A2.fields.b === B1,
           AliasIsB1: AliasOfB === B1,
           B1usesA1: B1.fields.a === A1,
           B2usesA2: B2.fields.a === A2,
           B2usesB1: B2.fields.b === B1 && B2.fields.c === B1,
         }));`,
      );
      expect(JSON.parse(output)).toStrictEqual({
        A1length: 2,
        A2usesB1: true,
        AliasIsB1: true,
        B1usesA1: true,
        B2usesA2: true,
        B2usesB1: true,
      });
    },
  );

  it('keeps emitting modules outside of the cycle eagerly', async () => {
    const weslSrc = {
      ...cyclicModules,
      'main.wesl': `
        import package::a::A2;
        struct Main { a: A2 }
      `,
    };
    expect(await emit(weslSrc)).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data';
      import { A2 } from './a.wesl?typegpu';
      export const Main = d.struct({
        a: A2
      }).$name("Main");"
    `);
    expect(
      await runEmitted(
        weslSrc,
        ['main', 'b'],
        `console.log(m0.Main.fields.a.fields.b === m1.B1);`,
      ),
    ).toBe('true');
  });

  it('emits untranslatable declarations of a cycle with a hoisted helper', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const weslSrc = {
      'a.wesl': `
        import package::b::B;
        struct A { b: B }
        struct Broken { v: vec3<MyT> }
      `,
      'b.wesl': `
        import package::a::A;
        import package::a::Broken;
        struct B { x: f32 }
        struct UsesA { a: A, broken: Broken }
      `,
    };
    expect(
      await runEmitted(
        weslSrc,
        ['b', 'a'],
        `console.log(m1.A.fields.b === m0.B, m0.UsesA.fields.a === m1.A);
         try { m1.Broken.propTypes; } catch (e) { console.log('throws'); }`,
      ),
    ).toBe('true true\nthrows');
  });

  it('names the types of a cycle that spans modules', async () => {
    const weslSrc = {
      'a.wesl': `
        import package::b::B;
        struct A { b: B }
      `,
      'b.wesl': `
        struct B { a: array<package::a::A, 2> }
      `,
    };
    await expect(emit(weslSrc, 'a.wesl')).rejects.toThrow(
      'Cyclic dependency between types from different modules: package::a::A -> package::b::B -> package::a::A',
    );
  });
});

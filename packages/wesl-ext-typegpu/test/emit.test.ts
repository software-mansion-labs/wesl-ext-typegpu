import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';
import { link, RecordResolver } from 'wesl';
import type { PluginExtensionApi } from 'wesl-plugin';

import { typegpuExtension } from '../src/index.ts';

/**
 * Runs the extension the same way wesl-plugin would for `import ... from '<weslRoot>/<modulePath>?typegpu'`,
 * but against an in-memory set of sources (keyed by path relative to the wesl root) instead of a bundler context.
 */
async function emit(
  weslSrc: Record<string, string>,
  modulePath = 'main.wesl',
): Promise<string> {
  const registry = new RecordResolver(weslSrc);
  const api = {
    weslMain: async () => modulePath,
    weslRegistry: async () => registry,
  } as Partial<PluginExtensionApi> as PluginExtensionApi;

  return typegpuExtension.emitFn(modulePath, api);
}

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
  ])('throws for the unsupported matrix type %s', async (type, message) => {
    await expect(
      emit({ 'main.wesl': `struct X { a: ${type} }` }),
    ).rejects.toThrow(message);
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
        alignedAttribute: d.align(16+16, Inner),
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

  it('throws for attributes without a TypeGPU counterpart', async () => {
    await expect(
      emit({
        'main.wesl': `
          struct Out {
            @blend_src(0) @location(0) color: vec4f,
          }
        `,
      }),
    ).rejects.toThrow('Attribute @blend_src is not supported by TypeGPU!');
  });

  it('throws for builtin values without a TypeGPU counterpart', async () => {
    await expect(
      emit({
        'main.wesl': `
          struct In {
            @builtin(not_a_builtin) value: u32,
          }
        `,
      }),
    ).rejects.toThrow(
      'Builtin value not_a_builtin is not supported by TypeGPU!',
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

it('throws when the module cannot be resolved', async () => {
  await expect(emit({}, 'missing.wesl')).rejects.toThrow(
    /Unable to resolve WESL module/,
  );
});

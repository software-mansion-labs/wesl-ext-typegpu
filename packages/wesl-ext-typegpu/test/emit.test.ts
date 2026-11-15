import { describe, expect, it } from 'vitest';
import { RecordResolver } from 'wesl';
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
    ).toMatchInlineSnapshot(`"import * as d from 'typegpu/data'"`);
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
      "import * as d from 'typegpu/data'
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
          }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data'
      export const Inner = d.struct({
        a: d.vec3f
      }).$name("Inner");
      export const Attributes = d.struct({
        alignedAttribute: d.align(16+16, Inner),
        sizedAttribute: d.size(16, Inner),
        locationAttribute: d.location(0, d.vec3f),
        interpolateAttribute: d.interpolate("flat", d.vec3f),
        interpolateTwoParamsAttribute: d.interpolate("linear, center", d.vec3f),
        builtinType: d.builtin.position
      }).$name("Attributes");"
    `);
  });

  it('translates struct attributes', async () => {
    expect(
      await emit({
        'main.wesl': `
          @location(0) struct Located { a: vec3f }
        `,
      }),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data'
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
      "import * as d from 'typegpu/data'
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
      "import * as d from 'typegpu/data'
      export const RuntimeSized = (__arrayLength => d.struct({
        d: d.arrayOf(d.f32, __arrayLength)
      }).$name("RuntimeSized"));"
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
      "import * as d from 'typegpu/data'
      import { StructA as StructA } from './structs.wesl?typegpu';
      import { StructB as StructB } from './structs.wesl?typegpu';
      import { NestedStructA as NestedStructA } from './folder/nestedStructs.wesl?typegpu';
      import { StructC as StructCAlias } from './structs.wesl?typegpu';
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
      "import * as d from 'typegpu/data'
      import { StructD as package$structs$StructD } from './structs.wesl?typegpu';
      import { NestedStructB as package$folder$nestedStructs$NestedStructB } from './folder/nestedStructs.wesl?typegpu';
      import { StructE as structs$StructE } from './structs.wesl?typegpu';
      import { NestedStructC as nestedStructs$NestedStructC } from './folder/nestedStructs.wesl?typegpu';
      import { StructF as ModuleAlias$StructF } from './structs.wesl?typegpu';
      import { NestedStructD as FolderAlias$nestedStructs$NestedStructD } from './folder/nestedStructs.wesl?typegpu';
      import { NestedStructE as NestedAlias$NestedStructE } from './folder/nestedStructs.wesl?typegpu';
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

  it('resolves super:: imports relative to the module', async () => {
    expect(
      await emit(
        {
          'folder/main.wesl': `
            import super::structs::StructA;

            struct ImportFromParent { importedFromParent: StructA }
          `,
          'structs.wesl': structs,
        },
        'folder/main.wesl',
      ),
    ).toMatchInlineSnapshot(`
      "import * as d from 'typegpu/data'
      import { StructA as StructA } from '../structs.wesl?typegpu';
      export const ImportFromParent = d.struct({
        importedFromParent: StructA
      }).$name("ImportFromParent");"
    `);
  });
});

it('throws when the module cannot be resolved', async () => {
  await expect(emit({}, 'missing.wesl')).rejects.toThrow(
    /Unable to resolve WESL module/,
  );
});

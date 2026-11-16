# wesl-ext-typegpu

An extension for [wesl-plugin](https://github.com/wgsl-tooling-wg/wesl-js) that turns the structs of a [WESL](https://wesl-lang.dev) module into [TypeGPU](https://typegpu.com) schemas. Import a shader file with the `?typegpu` suffix, and you get one `d.struct` per struct in that file (plus its aliases and consts), ready to use for buffers, vertex layouts and so on. The WGSL stays the single source of truth for your data layout.

```wgsl
// shaders/particles.wesl
struct Particle {
  position: vec3f,
  velocity: vec3f,
  color: vec4<f32>,
}
```

```ts
import { Particle } from '../shaders/particles.wesl?typegpu';
```

The import above resolves to a module equivalent to this:

<!-- prettier-ignore -->
```ts
import * as d from 'typegpu/data';
export const Particle = d.struct({
  position: d.vec3f,
  velocity: d.vec3f,
  color: d.vec4f,
}).$name('Particle');
```

> [!NOTE]
> The package is in alpha. See [Known limitations](#known-limitations) before relying on it.

## Installation

```sh
npm install typegpu
npm install --save-dev wesl wesl-plugin wesl-ext-typegpu
```

`typegpu`, `wesl` and `wesl-plugin` are peer dependencies. `typegpu` goes into your regular dependencies, since the generated code imports `typegpu` and `typegpu/data` at runtime. The extension itself runs at build time and requires Node.js 22 or newer.

## Setup

Register `typegpuExtension` with wesl-plugin. With Vite:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { typegpuExtension } from 'wesl-ext-typegpu';
import { linkBuildExtension } from 'wesl-plugin';
import weslPlugin from 'wesl-plugin/vite';

export default defineConfig({
  plugins: [weslPlugin({ extensions: [linkBuildExtension, typegpuExtension] })],
});
```

`linkBuildExtension` is only needed if you also use `?link` imports. wesl-plugin looks for shaders in `shaders/` next to your config by default; use a `wesl.toml` to change that (see the wesl-plugin docs).

For TypeScript to accept `?typegpu` imports, add this line to a `.d.ts` file in your project (or the top of a source file):

```ts
/// <reference types="wesl-ext-typegpu/suffixes" />
```

## Usage

### Importing structs

Every struct in the module becomes a named export with the same name. Functions and other declarations are ignored. Structs are emitted in dependency order, so a struct can use another one declared further down the file.

```ts
import tgpu from 'typegpu';

import { Particle } from '../shaders/particles.wesl?typegpu';

const root = await tgpu.init();
const particleBuffer = root.createBuffer(Particle).$usage('storage');
```

The exports are currently typed as `any`, so you get no type checking or autocompletion on them.

### Aliases and consts

Type aliases are exported as the schema they stand for. Module-level consts are exported as [`tgpu.const`](https://docs.swmansion.com/TypeGPU/fundamentals/variables/) declarations, so they can be used in TypeGPU shaders, and read in JavaScript through `.$`. They can hold scalars, vectors, matrices, arrays and structs, and can be built from literals, other consts, value constructors (`vec3f(...)`, `vec3(...)`, `array(...)`, `MyStruct(...)`, ...), component access (`v.xy`, `arr[1]`, `s.member`) and scalar arithmetic, comparisons and logic. Consts can also be used as array lengths and attribute arguments.

```wgsl
const MAX_LIGHTS = 4;
const UP = vec3f(0, 1, 0);
const DEFAULT_LIGHT = Light(UP, 1.0);
alias Color = vec4<f32>;
struct Light { direction: vec3f, intensity: f32 }
```

<!-- prettier-ignore -->
```ts
// equivalent to
import { tgpu } from 'typegpu';
import * as d from 'typegpu/data';
export const MAX_LIGHTS = tgpu.const(d.i32, 4).$name('MAX_LIGHTS');
export const UP = tgpu.const(d.vec3f, d.vec3f(0, 1, 0)).$name('UP');
export const Color = d.vec4f;
export const Light = d.struct({
  direction: d.vec3f,
  intensity: d.f32,
}).$name('Light');
export const DEFAULT_LIGHT = tgpu.const(Light, Light({ direction: UP.$, intensity: 1 })).$name('DEFAULT_LIGHT');
```

Types are inferred the way WGSL does it, also for consts and structs imported from other modules. Abstract values (`4`, `vec3(1, 2, 3)`) take the type of what they're used as, and otherwise become `i32` / `f32`, since TypeGPU can't declare consts of abstract types.

Consts that can't be translated (e.g. `const SUM = vec3f(1) + vec3f(2);` or `const M = max(1, 2);`) are left out. A struct that uses one in an array length or attribute can't be translated either (see [Errors](#errors)).

### Types from other modules

If a struct uses a struct, alias or const imported from another module, the generated code imports it from the other module's `?typegpu` version. This works from any directory, with `package::` and `super::` paths, `as` aliases, import trees and inline paths such as `package::common::Light` used directly as a field type.

```wgsl
// shaders/common.wesl
const MAX_LIGHTS = 4;

struct Light {
  direction: vec3f,
  intensity: f32,
}
```

```wgsl
// shaders/scene/forest.wesl
import package::common::{Light, MAX_LIGHTS};

struct Scene {
  sun: Light,
  lights: array<Light, MAX_LIGHTS>,
}
```

<!-- prettier-ignore -->
```ts
// `scene/forest.wesl?typegpu`, equivalent to
import * as d from 'typegpu/data';
import { Light, MAX_LIGHTS } from '../common.wesl?typegpu';
export const Scene = d.struct({
  sun: Light,
  lights: d.arrayOf(Light, MAX_LIGHTS.$),
}).$name('Scene');
```

Imports in the shader that nothing uses (functions, unused structs) don't show up in the output. Two modules may import from each other; such modules are emitted with lazy getters, so the order in which they're evaluated doesn't matter.

Types from WESL libraries (npm packages that wesl-plugin links, e.g. `import some_lib::math::Foo;`) can be imported the same way. The extension finds the library's module and emits its schemas too.

### Runtime-sized structs

A struct whose last member is a runtime-sized array (`array<T>` without a length) is exported as a function that takes the array length and returns the schema. The same goes for an alias of a runtime-sized array.

```wgsl
// shaders/particles.wesl
struct Particles {
  count: atomic<u32>,
  items: array<Particle>,
}
```

```ts
import { Particles } from '../shaders/particles.wesl?typegpu';

const ParticlesOf1000 = Particles(1000);
const buffer = root.createBuffer(ParticlesOf1000).$usage('storage');
```

### Conditions

`@if`, `@elif` and `@else` are evaluated like the linker does. Conditions come from the import query (the wesl-plugin syntax), and an unset condition is false. They're forwarded to the modules the generated code imports from.

```wgsl
// shaders/material.wesl
struct Material {
  albedo: vec3f,
  @if(DEBUG) debugColor: vec4f,
}
```

```ts
import { Material } from '../shaders/material.wesl?typegpu'; // albedo only
import { Material as DebugMaterial } from '../shaders/material.wesl?DEBUG&typegpu'; // albedo and debugColor
```

The `wesl-ext-typegpu/suffixes` types only cover imports ending in `?typegpu`. For imports with conditions, add your own declaration:

```ts
declare module '*&typegpu';
```

### Errors

A struct or alias that can't be translated doesn't fail the whole import. It's exported as a placeholder that throws when used, and the build prints a warning that points at the source:

```
[wesl-ext-typegpu] ./broken.wesl:6:6: Cannot translate struct 'Broken', member 'a': Matrix type 'mat2x3f' is not supported by TypeGPU, supported matrix types are: mat2x2f, mat3x3f, mat4x4f in 'mat2x3f'
```

Structs that depend on a broken one are broken too, and their message names the root cause. Problems with the module as a whole fail the import: a module that can't be resolved, types that contain each other, or a missing library.

## What is supported

| WGSL                               | TypeGPU                                         | Notes                                                                    |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| `f32`, `f16`, `i32`, `u32`, `bool` | `d.f32`, `d.f16`, `d.i32`, `d.u32`, `d.bool`    |                                                                          |
| `vec3f`, `vec2<i32>`, ...          | `d.vec3f`, `d.vec2i`, ...                       | Shorthand and templated forms, for `f32`, `f16`, `i32`, `u32` and `bool` |
| `mat4x4f`, `mat4x4<f32>`, ...      | `d.mat4x4f`, ...                                | `mat2x2`, `mat3x3` and `mat4x4` of `f32`, the matrices TypeGPU has       |
| `array<T, N>`                      | `d.arrayOf(T, N)`                               | `N` can use consts and arithmetic                                        |
| `array<T>`                         | `d.arrayOf(T, n)`                               | Last member only; the struct becomes a function of `n`                   |
| `atomic<T>`                        | `d.atomic(T)`                                   |                                                                          |
| `ptr<space, T, mode>`              | `d.ptrUniform(T)`, `d.ptrStorage(T, mode)`, ... |                                                                          |
| `struct`                           | `d.struct({ ... })`                             |                                                                          |
| `alias`                            | the aliased schema                              |                                                                          |
| `const`                            | `tgpu.const(T, value)`                          | Scalars, vectors, matrices, arrays and structs                           |
| `@align(n)`, `@size(n)`            | `d.align(n, T)`, `d.size(n, T)`                 | `n` can use consts and arithmetic                                        |
| `@location(n)`                     | `d.location(n, T)`                              |                                                                          |
| `@interpolate(...)`                | `d.interpolate('...', T)`                       | One or two parameters                                                    |
| `@builtin(name)`                   | `d.builtin.name`                                | Snake case becomes camel case, e.g. `vertex_index` → `vertexIndex`       |
| `@invariant`                       | `d.invariant(T)`                                |                                                                          |
| `@if`, `@elif`, `@else`            | members and declarations left in or out         | On structs, members, aliases, consts and imports                         |

## Known limitations

- The exports of `?typegpu` modules are typed as `any`.
- Attributes and builtins without a TypeGPU counterpart (`@diagnostic`, `@blend_src`, ...) make the struct untranslatable.
- Consts, array lengths and attribute arguments can't call functions (`max(1, 2)`) or use `override` declarations, and consts can't use arithmetic on vectors and matrices.
- Non-square and `f16` matrices aren't supported, since TypeGPU doesn't have them.
- Type names the extension doesn't recognise are emitted as `d.<name>` without a check, so a misspelled type shows up as `undefined` at runtime rather than at build time.
- Imports with conditions need the extra `declare module` shown in [Conditions](#conditions).
- wesl 0.7 can't parse inline type paths with more than one `super::` (`super::super::common::Light`). Import the type with an `import` statement instead.
- Import cycles between modules of a WESL library aren't handled.

## TypeGPU is created by Software Mansion

[![swm](https://logo.swmansion.com/logo?color=white&variant=desktop&width=150&tag=typegpu-github 'Software Mansion')](https://swmansion.com)

Since 2012 [Software Mansion](https://swmansion.com) is a software agency with experience in building web and mobile apps. We are Core React Native Contributors and experts in dealing with all kinds of React Native issues. We can help you build your next dream product – [Hire us](https://swmansion.com/contact/projects?utm_source=typegpu&utm_medium=readme).

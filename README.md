# wesl-ext-typegpu

An extension for [wesl-plugin](https://github.com/wgsl-tooling-wg/wesl-js) that turns the structs of a [WESL](https://wesl-lang.dev) module into [TypeGPU](https://typegpu.com) schemas. Import a shader file with the `?typegpu` suffix, and you get one `d.struct` per struct in that file, ready to use for buffers, vertex layouts and so on. The WGSL stays the single source of truth for your data layout.

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

```ts
import * as d from 'typegpu/data';
export const Particle = d
  .struct({
    position: d.vec3f,
    velocity: d.vec3f,
    color: d.vec4f,
  })
  .$name('Particle');
```

> [!NOTE]
> The package is in alpha. See [Known limitations](#known-limitations) before relying on it.

## Installation

```sh
npm install typegpu
npm install --save-dev wesl wesl-plugin wesl-ext-typegpu
```

`wesl` and `wesl-plugin` are peer dependencies. `typegpu` is not a dependency of the extension itself, but the generated code imports `typegpu/data`, so your app needs it. The extension runs at build time and requires Node.js 22 or newer.

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

### Structs from other modules

If a struct uses a struct imported from another module of your shader package, the generated code imports that struct from the other module's `?typegpu` version.

```wgsl
// shaders/common.wesl
struct Light {
  direction: vec3f,
  intensity: f32,
}
```

```wgsl
// shaders/scene.wesl
import package::common::Light;

struct Scene {
  sun: Light,
  lights: array<Light, 4>,
}
```

```ts
// `scene.wesl?typegpu`, equivalent to
import * as d from 'typegpu/data';

import { Light } from './common.wesl?typegpu';
export const Scene = d
  .struct({
    sun: Light,
    lights: d.arrayOf(Light, 4),
  })
  .$name('Scene');
```

Imports in the shader that no struct uses (functions, unused structs) don't show up in the output. Inline paths such as `package::common::Light` used directly as a field type work too.

### Runtime-sized structs

A struct whose last member is a runtime-sized array (`array<T>` without a length) is exported as a function that takes the array length and returns the schema.

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

## What is supported

| WGSL                               | TypeGPU                                         | Notes                                                                      |
| ---------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `f32`, `f16`, `i32`, `u32`, `bool` | `d.f32`, `d.f16`, `d.i32`, `d.u32`, `d.bool`    |                                                                            |
| `vec3f`, `vec2<i32>`, ...          | `d.vec3f`, `d.vec2i`, ...                       | Shorthand and templated forms, for `f32`, `f16`, `i32`, `u32` and `bool`   |
| `mat2x2f`, `mat3x3f`, `mat4x4f`    | `d.mat2x2f`, `d.mat3x3f`, `d.mat4x4f`           | Shorthand form only. TypeGPU has no non-square or `f16` matrices           |
| `array<T, N>`                      | `d.arrayOf(T, N)`                               | `N` must be a literal                                                      |
| `array<T>`                         | `d.arrayOf(T, n)`                               | Last member only; the struct becomes a function of `n`                     |
| `atomic<T>`                        | `d.atomic(T)`                                   |                                                                            |
| `ptr<space, T, mode>`              | `d.ptrUniform(T)`, `d.ptrStorage(T, mode)`, ... |                                                                            |
| Structs                            | `d.struct({ ... })`                             | From the same module or imported from another module of the package        |
| `@align(n)`                        | `d.align(n, T)`                                 | `n` must be a literal                                                      |
| `@size(n)`                         | `d.size(n, T)`                                  | `n` must be a literal                                                      |
| `@location(n)`                     | `d.location(n, T)`                              |                                                                            |
| `@interpolate(...)`                | `d.interpolate('...', T)`                       | One or two parameters                                                      |
| `@builtin(name)`                   | `d.builtin.name`                                | Snake case is converted to camel case, e.g. `vertex_index` → `vertexIndex` |

Struct imports work with `package::` paths, `as` aliases, one-level import trees (`package::a::{B, C}`) and inline paths in field types, as long as the importing module sits at the root of the shader directory. See the limitations below.

## Known limitations

- The exports of `?typegpu` modules are typed as `any`.
- Only the attributes in the table above are handled. `@diagnostic` and conditional attributes (`@if`, `@elif`, `@else`) make the import fail.
- `@builtin` replaces the member's whole type, so other attributes on the same member are dropped.
- Array lengths and attribute arguments are copied into JavaScript as written. Constants such as `array<f32, COUNT>` don't work; use literals.
- Templated matrix types (`mat4x4<f32>`) are not supported; use the shorthand (`mat4x4f`).
- Type aliases (`alias`) are not supported.
- Import paths are only resolved correctly in modules at the root of the shader directory. In nested modules, `package::` paths are resolved relative to the module's own directory. `super::` paths point one directory too high, and nested import trees (`package::{a::B}`) lose their separators.
- Structs from WESL libraries (dependencies other than your own `package`) can't be imported.
- Two modules that import structs from each other are not supported.
- A struct named `d` collides with the `typegpu/data` namespace import in the generated code.

## TypeGPU is created by Software Mansion

[![swm](https://logo.swmansion.com/logo?color=white&variant=desktop&width=150&tag=typegpu-github 'Software Mansion')](https://swmansion.com)

Since 2012 [Software Mansion](https://swmansion.com) is a software agency with experience in building web and mobile apps. We are Core React Native Contributors and experts in dealing with all kinds of React Native issues. We can help you build your next dream product – [Hire us](https://swmansion.com/contact/projects?utm_source=typegpu&utm_medium=readme).

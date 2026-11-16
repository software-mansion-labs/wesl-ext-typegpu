/**
 * Generated TypeGPU schemas for structs defined in a WESL module.
 * Every export is typed as `any` for now, since they depend on the shader contents.
 *
 * Add `/// <reference types="wesl-ext-typegpu/suffixes" />` to use.
 *
 * Conditions can be passed in the query before `typegpu`, e.g. `./file.wesl?DEBUG&typegpu`.
 * Ambient module patterns allow a single `*`, so `typegpu` has to be the last segment
 * of the query for TypeScript to find these declarations (`./file.wesl?typegpu&DEBUG`
 * still builds, but doesn't typecheck).
 */
declare module '*?typegpu';
declare module '*&typegpu';

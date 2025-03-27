import package::uniforms::Uniforms;

struct Nested {
  a: vec3f,
}

struct TestStruct {
  standardType: vec3f,
  arrayType: array<vec4f, 3>,
  atomicType: atomic<u32>,
  nestedType: Nested,
  definedBelowType: DefinedBelow,
  pointerType: ptr<storage, array<f32>, read_only>,
  @align(16) aligned: Nested,
//  @size(16) sized: Nested,
  @location(0) locationType: vec3f,
  @interpolate(flat) interpolateType: vec3f,
  @location(0) @interpolate(flat) locationInterpolateType: vec3f,
}

struct DefinedBelow {
  b: vec3f,
}
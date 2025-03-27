import package::importStruct::Imported;
import package::importStructTree::{Imported1, Imported2, my_function};

struct DefinedAbove {
  a: vec3f,
}

struct TestStruct {
  standardType: vec3f,
  standardUnwrappedType: vec3<f32>,
  booleanVectorType: vec3<bool>,
  arrayType: array<vec4f, 3>,
  atomicType: atomic<u32>,
  definedAboveType: DefinedAbove,
  definedBelowType: DefinedBelow,
  definedBelowInArrayType: array<array<DefinedBelowInArray, 4>, 2>,
  importedType: Imported,
  importedTreeType: Imported1,
  pointerType: ptr<storage, array<f32>, read_only>,
  @align(16) alignedAttribute: DefinedAbove,
//  @size(16) sizedAttribute: DefinedAbove,
  @location(0) locationAttribute: vec3f,
  @interpolate(flat) interpolateAttribute: vec3f,
  @location(0) @interpolate(flat) locationInterpolateAttribute: vec3f,
}

struct DefinedBelow {
  b: vec3f,
}

struct DefinedBelowInArray {
  c: vec3f,
}





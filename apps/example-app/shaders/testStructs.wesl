import package::importStruct::Imported;
import package::importStructTree::{ImportedFromTree1, ImportedFromTree2, my_function};
import package::importStructModule;

struct DefinedAbove {
  a: vec3f,
}

struct TestStruct {
  standardType: vec3f,
  standardUnwrappedType: vec3<f32>,
  booleanVectorType: vec3<bool>,

  arrayWithLengthType: array<vec4f, 3>,
//  arrayWithoutLengthType: array<vec2<u32>>,
  atomicType: atomic<u32>,
  uniformPointerType: ptr<uniform, array<f32, 4>, read_only>,
  storagePointerType: ptr<storage, array<f32, 4>, read_only>,

  definedAboveType: DefinedAbove,
  definedBelowType: DefinedBelow,
  definedBelowInArrayType: array<array<DefinedBelowInArray, 4>, 2>,

  importedType: Imported,
  importedTreeType: ImportedFromTree1,
  importedModuleType: importStructModule::ImportedFromModule,

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





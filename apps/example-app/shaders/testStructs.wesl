import package::importStruct::Imported;
import package::importStructTree::{ImportedFromTree1, ImportedFromTree2, my_function};
import package::importStructModule;

struct DefinedAbove {
  a: vec3f,
}

@location(0) struct TestStruct {
  standardType: vec3f,
  standardUnwrappedType: vec3<f32>,
  booleanVectorType: vec3<bool>,

  arrayWithLengthType: array<vec4f, 3>,
//  arrayWithoutLengthType: array<vec2<u32>>,
  atomicType: atomic<u32>,
  uniformPointerType: ptr<uniform, array<f32, 4>, read_write>,
  storagePointerType: ptr<storage, array<f32, 4>, read_write>,

  definedAboveType: DefinedAbove,
  definedBelowType: DefinedBelow,
  definedBelowInArrayType: array<array<DefinedBelowInArray, 4>, 2>,

  @align(16) alignedAttribute: DefinedAbove,
  @size(16) sizedAttribute: DefinedAbove,
  @location(0) locationAttribute: vec3f,
  @interpolate(flat) interpolateAttribute: vec3f,
  @location(1) @interpolate(flat) locationInterpolateAttribute: vec3f,
  @builtin(position) builtinType: vec4f,

//  importedType: Imported,
//  importedTreeType: ImportedFromTree1,
//  importedModuleType: importStructModule::ImportedFromModule,
}

struct DefinedBelow {
  b: vec3f,
}

struct DefinedBelowInArray {
  c: vec3f,
}



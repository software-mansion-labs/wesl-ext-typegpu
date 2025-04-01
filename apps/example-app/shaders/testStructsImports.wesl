import package::importStruct::Imported;
//import package::importStructTree::{ImportedFromTree1, ImportedFromTree2, my_function};
//import package::importStructModule;
//import package::folder::importNested::ImportedNested;

struct TestStruct {
  importedType: Imported,
//  importedTreeType: ImportedFromTree1,
//  importedModuleType: importStructModule::ImportedFromModule,
//  importedNested: ImportedNested,
}

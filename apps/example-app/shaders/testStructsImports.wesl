import package::importStruct::Imported;
//import package::folder::importNested::ImportedNested;
import package::importStructTree::{ImportedFromTree1, ImportedFromTree2, my_function};
//import package::importStructModule;

struct TestStruct {
  importedType: Imported,
//  importedNested: ImportedNested,
  importedTreeType: ImportedFromTree1,
//  importedModuleType: importStructModule::ImportedFromModule,
}

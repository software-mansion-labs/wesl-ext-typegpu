import package::importStruct::Imported;
import package::importStructTree::{ImportedFromTree1, ImportedFromTree2, my_function};
import package::folder::importNested::ImportedNested;
//import package::importStructModule;

struct TestStruct {
  importedType: Imported,
  importedTreeType: ImportedFromTree1,
  importedNested: ImportedNested,
//  importedModuleType: importStructModule::ImportedFromModule,
}

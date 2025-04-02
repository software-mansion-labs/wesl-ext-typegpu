import package::importStruct::Imported;
import package::importStructTree::{ImportedFromTree1, ImportedFromTree2, my_function};
import package::folder::importNested::ImportedNested;
//import super::importStructFromParent::ImportedFromParent;
//import package::importStructModule;

struct TestStruct {
  importedType: Imported,
  importedTreeType: ImportedFromTree1,
  importedNested: ImportedNested,
//  importedFromParent: ImportedFromParent,
//  importedModuleType: importStructModule::ImportedFromModule,
}

import package::importStruct::Imported;
import bevy_pbr::forward_io::ImportToIgnore;
import package::importStructTree::{ImportedFromTree1, ImportedFromTree2, my_function};
import package::folder::importNested::ImportedNested;
import package::importStructWithAlias::ImportedWithAlias as StructAlias;
import package::importStructModule;

struct TestStruct {
  importedType: Imported,
  importedTreeType: ImportedFromTree1,
  importedNested: ImportedNested,
  importedAlias: StructAlias,
//  importedDirectlyFromPackage: package::importStruct::Imported,
  importedModuleType: importStructModule::ImportedFromModule,
}

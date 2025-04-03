import package::importStruct::Imported;
import bevy_pbr::forward_io::ImportToIgnore;
import package::importStructTree::{ImportedFromTree1, ImportedFromTree2, my_function};
import package::folder::importNested::ImportedNested;
import package::importStructWithAlias::ImportedWithAlias as StructAlias;
import package::importStructModule;
import package::folder::importNested;
import package::importStruct as ModuleAlias;
import package::folder as FolderAlias;
import package::folder::importNested as NestedAlias;

struct TestStruct {
  imported: Imported,
  importedTree: ImportedFromTree1,
  importedNested: ImportedNested,
  importedAlias: StructAlias,
  inlinedDirectlyFromPackage: package::importStruct::Imported,
  inlinedModule: importStructModule::ImportedFromModule,
//  inlinedNestedModule: importNested::ImportedNested,
//  inlinedAlias: ModuleAlias::Imported,
//  inlinedFolderAlias: FolderAlias::importNested::ImportedNested,
//  inlinedNestedAlias: NestedAlias::ImportedNested,
}

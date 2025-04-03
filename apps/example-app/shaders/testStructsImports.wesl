import bevy_pbr::forward_io::ImportToIgnore;
import package::structs::StructA;
import package::structs::{StructB, my_function};
import package::folder::structs::NestedStructA;
import package::structs::StructC as StructCAlias;
import package::structs;
import package::folder::importNested;
import package::structs as ModuleAlias;
import package::folder as FolderAlias;
import package::folder::importNested as NestedAlias;

struct TestStruct {
  imported: StructA,
  importedFromTree: StructB,
  importedNested: NestedStructA,
  importedAlias: StructCAlias,
  inlinedDirectlyFromPackage: package::structs::StructD,
  inlinedModule: structs::StructE,
//  inlinedNestedModule: importNested::ImportedNested,
//  inlinedAlias: ModuleAlias::StructA,
//  inlinedFolderAlias: FolderAlias::importNested::ImportedNested,
//  inlinedNestedAlias: NestedAlias::ImportedNested,
}

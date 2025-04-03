import bevy_pbr::forward_io::ImportToIgnore;
import package::structs::StructA;
import package::structs::{StructB, function_to_ignore};
import package::folder::nestedStructs::NestedStructA;
import package::structs::StructC as StructCAlias;
import package::structs;
import package::folder::nestedStructs;
import package::structs as ModuleAlias;
import package::folder as FolderAlias;
import package::folder::nestedStructs as NestedAlias;

struct TestStruct {
  imported: StructA,
  importedFromTree: StructB,
  importedNested: NestedStructA,
  importedAlias: StructCAlias,
  inlinedDirectlyFromPackage: package::structs::StructD,
  inlinedNestedDirectlyFromPackage: package::folder::nestedStructs::NestedStructB,
  inlinedModule: structs::StructE,
  inlinedNestedModule: nestedStructs::NestedStructC,
  inlinedAlias: ModuleAlias::StructF,
  inlinedFolderAlias: FolderAlias::nestedStructs::NestedStructD,
  inlinedNestedAlias: NestedAlias::NestedStructE,
}

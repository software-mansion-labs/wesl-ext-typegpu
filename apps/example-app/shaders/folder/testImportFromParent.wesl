// The first `super` is this module's own directory (`folder`), so reaching
// `shaders/structs.wesl` in the parent directory takes two.
import super::super::structs::StructA;

struct TestStructImportFromParent {
  importedFromParent: StructA,
}

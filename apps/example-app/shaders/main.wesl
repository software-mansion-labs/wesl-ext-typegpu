import package::testStructs::TestStruct;

struct VertexOutput {
  @builtin(position) position: vec4f,
}

@vertex
fn main_vertex(@builtin(vertex_index) idx: u32) -> VertexOutput {
  let POS = array<vec2f, 3>(
    vec2(0.0, 0.5),
    vec2(-0.5, -0.5),
    vec2(0.5, -0.5)
  );

  var output: VertexOutput;
  output.position = vec4f(POS[idx], 0.0, 1.0);
  return output;
}


@fragment
fn main_fragment() -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 0.0, 1.0);
}

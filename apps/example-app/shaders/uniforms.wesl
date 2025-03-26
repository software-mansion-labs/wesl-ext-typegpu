struct Uniforms {
  attributeUndefined: vec3f,
  arrayType: array<vec4f, 3>,
  @location(0) attributeLocation: vec3f,
  @interpolate(flat) attributeInterpolate: vec3f,
  @location(0) @interpolate(flat) attributeLocationInterpolate: vec3f,
}

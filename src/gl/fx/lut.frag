#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler2D u_input;
uniform sampler3D u_lut;
uniform float u_intensity;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec4 src = texture(u_input, v_texCoord);
  // Media is uploaded as raw bytes with UNPACK_COLORSPACE_CONVERSION_WEBGL set
  // to NONE into an RGBA8 texture, and written back to an RGBA8 framebuffer, so
  // the sampled value carries whatever transfer function the source file was
  // encoded with. A .cube LUT is authored against exactly that encoding — the
  // bundled ones convert S-Log3 and Canon Log 3 straight to Rec.709 — so the
  // lookup coordinate is the sampled value itself. Applying a transfer function
  // on the way in would index the LUT at a luminance the footage never had, and
  // one on the way out would undo the LUT's own output encoding.
  vec3 encoded = clamp(src.rgb, vec3(0.0), vec3(1.0));
  vec3 graded = texture(u_lut, encoded).rgb;
  fragColor = vec4(mix(encoded, graded, u_intensity), src.a);
}

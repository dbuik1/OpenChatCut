#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_intensity;
uniform float u_blockSize;
uniform float u_speed;
uniform float u_burst;
uniform float u_colorSplit;
uniform float u_noise;
uniform float u_scanlines;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;

float hash(float n) { return fract(sin(n) * 43758.5453123); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

// Output stays premultiplied: every colour operation scales by the sampled alpha
// so a clip with transparency does not glow or invert to opaque.
void main() {
  vec2 uv = v_texCoord;

  // Bursts: the glitch is gated by a clock that opens for short stretches, so
  // the picture is clean between hits instead of shimmering continuously.
  float clock = u_time * max(u_speed, 0.05) * 8.0;
  float tick = floor(clock);
  float gate = hash(tick * 0.731) < u_burst ? 1.0 : 0.0;
  float amt = u_intensity * gate * (0.55 + 0.45 * hash(tick * 1.913));
  float hit = min(amt, 1.5);

  // Vertical roll during a burst, as a tracking fault would.
  uv.y = fract(uv.y + amt * (hash(tick * 2.17) - 0.5) * 0.08);

  // Horizontal bands displaced sideways, coarse and fine.
  float rows = max(u_blockSize, 2.0);
  float band = floor(uv.y * rows);
  float bandSeed = hash(band + tick * 13.7);
  float shift = 0.0;
  if (bandSeed > 1.0 - 0.35 * hit) shift += (hash(band * 3.1 + tick) - 0.5) * 0.25 * amt;
  float fine = floor(uv.y * rows * 4.0);
  if (hash(fine * 0.37 + tick * 7.3) > 1.0 - 0.15 * hit) shift += (hash(fine + tick) - 0.5) * 0.06 * amt;

  // Square tiles copied in from elsewhere, like a corrupted keyframe.
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 tile = floor(uv * vec2(rows * 0.5 * aspect, rows * 0.5));
  vec2 tileOffset = vec2(0.0);
  if (hash2(tile + tick) > 1.0 - 0.08 * hit) {
    tileOffset = (vec2(hash2(tile * 1.7 + tick), hash2(tile * 2.3 + tick)) - 0.5) * 0.3 * amt;
  }
  vec2 suv = clamp(uv + vec2(shift, 0.0) + tileOffset, 0.0, 1.0);

  // Channel split whose direction and width change with every burst.
  float split = u_colorSplit * amt * 0.02 * (0.5 + hash(tick * 5.1));
  float ang = hash(tick * 3.3) * 6.2832;
  vec2 dir = vec2(cos(ang), sin(ang)) * split;
  vec4 c = texture(u_input, suv);
  c.r = texture(u_input, clamp(suv + dir, 0.0, 1.0)).r;
  c.b = texture(u_input, clamp(suv - dir, 0.0, 1.0)).b;

  // Static in some bands.
  float grain = hash2(vec2(floor(uv.x * 160.0), floor(uv.y * 90.0)) + fract(u_time * 60.0) * 17.0);
  float noiseMask = step(1.0 - 0.25 * hit, hash(band * 9.7 + tick * 0.5));
  c.rgb = mix(c.rgb, vec3(grain) * c.a, u_noise * noiseMask * min(amt, 1.0));

  // Occasional inversion and colour crush on a band.
  if (amt > 0.2 && bandSeed > 0.985 - 0.02 * amt) c.rgb = c.a - c.rgb;
  if (amt > 0.2 && hash(band * 4.4 + tick * 2.2) > 0.97 - 0.02 * amt) c.rgb = floor(c.rgb * 4.0) / 4.0;

  // Scanlines and a faint brightness flicker on hits.
  float scan = 1.0 - u_scanlines * 0.35 * (0.5 + 0.5 * sin(v_texCoord.y * u_resolution.y * 3.14159));
  float flicker = 1.0 - 0.06 * amt * hash(floor(u_time * 24.0));
  c.rgb *= scan * flicker;

  fragColor = c;
}

/**
 * 短片合成用的着色器。房间那几镜直接用应用左页的着色器（src/renderer/src/book/wash/shaders.ts），
 * 保证片子最后一帧和现场的书一模一样；这里只补应用里没有的：
 *
 * - FILM：关键帧（NovelAI 出的整幅画）的合成。和应用同一套做法：颜色聚在画面里、边缘褪成铅笔线，
 *   上色和褪色都是笔触（揭开遮罩 R 管铅笔、B 管颜色），另加风把颜色卷走、笔尖一滴墨晕开、夜色调色。
 * - PLACE：把一层（合成好的画、截下来的书页、笔和花瓣）按变换矩阵贴进画面，可羽化边缘。
 * - PAPER：纸色打底，带一点颗粒。
 *
 * 纹理约定同应用：图的第 0 行是顶边；合成进目标纹理的几遍（VERTEX 画的）上下颠倒，贴的时候翻回来。
 */

const NOISE = /* glsl */ `
float hash(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.9375;
}
float warped(vec2 p) {
  vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
  return fbm(p + 1.8 * q) * 2.0 - 1.0;
}`

export const FILM = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uPencil;
uniform sampler2D uReveal;   // R 铅笔揭到哪里、B 颜色画到哪里
uniform float uUseReveal;    // 0：不看遮罩，铅笔和颜色都满
uniform float uLines;        // 铅笔线的浓度
uniform float uColorAmt;     // 颜色整体的量（0 只剩线稿）
uniform float uDry;
uniform float uWet;
uniform vec2 uRevealTexel;
uniform vec3 uGraphite;
uniform vec4 uEdge;          // x 颜色边缘羽化宽度（以画面高为 1）、y 毛边、z 线稿边缘羽化宽度
uniform vec3 uGrade;         // 亮度、饱和度、染色量
uniform vec3 uTint;
uniform vec4 uSweep;         // x 风的前沿位置、y 方向（弧度）、z 带宽、w 开关
uniform vec3 uSweepStyle;    // x 颜色被推走多远、y 拉成一道道的程度、z 线稿是否一起卷走
uniform float uTime;
uniform vec4 uInk;           // xy 墨滴中心、z 半径（以画面高为 1）、w 浓度
uniform vec3 uInkColor;
uniform float uAspect;       // 宽 / 高
in vec2 vUv;
out vec4 outColor;
${NOISE}

vec3 grade(vec3 c) {
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uGrade.y) * uGrade.x;
  return mix(c, c * uTint, uGrade.z);
}

// 画面边缘：颜色在离边 uEdge.x 以内褪掉，边线带水彩的毛边；铅笔线褪得更晚
float edge(vec2 uv, float width) {
  if (width <= 0.0) return 1.0;
  float dx = min(uv.x, 1.0 - uv.x) * uAspect;
  float dy = min(uv.y, 1.0 - uv.y);
  float d = min(dx, dy) + warped(uv * vec2(uAspect, 1.0) * 5.0) * uEdge.y * width;
  return smoothstep(0.0, width, d);
}

// 颜色这一层（预乘）：遮罩里画到的地方、边缘以内
vec4 colorLayer(vec2 uv) {
  float paint = 1.0;
  float wetEdge = 0.0;
  if (uUseReveal > 0.5) {
    paint = texture(uReveal, uv).b;
    float gx = texture(uReveal, uv + vec2(uRevealTexel.x, 0.0)).b - texture(uReveal, uv - vec2(uRevealTexel.x, 0.0)).b;
    float gy = texture(uReveal, uv + vec2(0.0, uRevealTexel.y)).b - texture(uReveal, uv - vec2(0.0, uRevealTexel.y)).b;
    wetEdge = smoothstep(0.03, 0.22, length(vec2(gx, gy))) * (1.0 - uDry) * step(0.02, paint);
  }
  vec3 c = grade(texture(uColor, uv).rgb);
  c = mix(c, c * c, 0.55 * uWet * wetEdge);
  float grain = 0.86 + 0.14 * vnoise(uv * vec2(uAspect, 1.0) * 420.0);
  float coverage = smoothstep(0.0, 0.8, paint);
  float a = mix(coverage * grain, 1.0, step(0.999, coverage)) * edge(uv, uEdge.x) * uColorAmt;
  return vec4(c * a, a);
}

void main() {
  vec2 uv = vUv;
  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);

  float lineReveal = uUseReveal > 0.5 ? texture(uReveal, uv).r : 1.0;
  float lines = texture(uPencil, uv).r * lineReveal * uLines * edge(uv, uEdge.z);
  vec4 color;

  if (uSweep.w > 0.5) {
    // 风把颜色卷走：前沿扫过的地方，颜色顺着风向拉长、变成一道道，最后只剩纸
    vec2 dir = vec2(cos(uSweep.y), sin(uSweep.y));
    vec2 nrm = vec2(-dir.y, dir.x);
    float along = dot(q, dir);
    float across = dot(q, nrm);
    float jag = (fbm(vec2(across * 3.0 + 3.1, uTime * 0.35)) - 0.5) * uSweep.z;
    float p = clamp((uSweep.x - along + jag) / uSweep.z, 0.0, 1.0);
    // 颜色先被拉成一道浓的色带（前沿后面一段还很实），再散成一道道、消失
    vec2 off = dir * (p * uSweepStyle.x) / vec2(uAspect, 1.0);
    vec4 acc = vec4(0.0);
    for (int k = 0; k < 10; k++) acc += colorLayer(uv - off * (float(k) / 9.0));
    color = acc / 10.0;
    float streak = fbm(vec2(along * 2.5 - uTime * 1.6, across * 26.0));
    color *= (1.0 - smoothstep(0.4, 1.0, p)) * mix(1.0, 0.45 + 0.8 * streak, smoothstep(0.0, 0.25, p) * uSweepStyle.y);
    if (uSweepStyle.z > 0.5) lines *= 1.0 - smoothstep(0.15, 0.85, p);
  } else {
    color = colorLayer(uv);
  }

  vec4 outp = vec4(uGraphite * lines, lines);
  if (uInk.w > 0.0) {
    // 笔尖的一滴墨：边缘颜料堆积的一圈，边线是不规则的水彩边
    float r = length((uv - uInk.xy) * vec2(uAspect, 1.0));
    float n = warped(uv * vec2(uAspect, 1.0) * 7.0) * 0.38 * uInk.z;
    float blot = 1.0 - smoothstep(uInk.z * 0.92, uInk.z * 1.02 + 0.002, r + n);
    float ring = smoothstep(uInk.z * 0.5, uInk.z, r + n) * blot;
    // 水彩的一滴：中间被水冲淡，边上颜料堆起一圈
    vec3 ink = mix(mix(uInkColor, vec3(1.0), 0.35), uInkColor, ring);
    float ia = blot * uInk.w * (0.55 + 0.45 * ring);
    outp = vec4(ink * ia, ia) + outp * (1.0 - ia);
  }
  outColor = color + outp * (1.0 - color.a);
}`

export const PLACE_VERTEX = /* glsl */ `#version 300 es
uniform mat3 uMatrix;  // 单位方块 (u, v) → 裁剪空间
out vec2 vUv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vUv = corner;
  vec3 p = uMatrix * vec3(corner, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`

export const PLACE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uFlip;
uniform float uAlpha;
uniform vec4 uFeather;  // 左、上、右、下的羽化宽度（单位方块的比例）
uniform float uRagged;
uniform vec4 uMul;      // 颜色乘上 rgb（a 为 1 时）
in vec2 vUv;
out vec4 outColor;
${NOISE}
void main() {
  vec2 uv = vec2(vUv.x, uFlip > 0.5 ? 1.0 - vUv.y : vUv.y);
  vec4 c = texture(uTex, uv);
  c.rgb *= mix(vec3(1.0), uMul.rgb, uMul.a);
  float n = uRagged > 0.0 ? warped(vUv * 6.0) * uRagged : 0.0;
  float f = 1.0;
  if (uFeather.x > 0.0) f *= smoothstep(0.0, uFeather.x, vUv.x + n * uFeather.x);
  if (uFeather.y > 0.0) f *= smoothstep(0.0, uFeather.y, vUv.y + n * uFeather.y);
  if (uFeather.z > 0.0) f *= smoothstep(0.0, uFeather.z, 1.0 - vUv.x + n * uFeather.z);
  if (uFeather.w > 0.0) f *= smoothstep(0.0, uFeather.w, 1.0 - vUv.y + n * uFeather.w);
  outColor = c * uAlpha * f;
}`

export const PAPER = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uPaper;
uniform vec2 uSize;
in vec2 vUv;
out vec4 outColor;
${NOISE}
void main() {
  vec2 px = vUv * uSize;
  float grain = vnoise(px * 0.55) * 0.6 + vnoise(px * 0.13) * 0.4;
  outColor = vec4(uPaper * (0.988 + 0.016 * grain), 1.0);
}`

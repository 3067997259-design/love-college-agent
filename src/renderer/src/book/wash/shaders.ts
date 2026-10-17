/**
 * 左页房间的着色器（WebGL2）。赛前练习页只留下做法和参数（体验设计 §7.1），这里赛中重写。
 *
 * 纹理约定：所有纹理第 0 行都是图的顶边，合成时直接用 vUv 取样；画进帧缓冲的几遍把纵向翻回来，保持同一约定。
 *
 * - EXTRACT：每张整景图跑一次，提取铅笔层（两级高斯的差找细线，暗处一层淡调子，乘纸纹颗粒）。
 *   2026-10-16 用户批准：精修图和旧线稿不再对齐，铅笔底由着色器从彩图实时提取，天然逐像素对齐。
 * - DIFF／OPEN：有她的图减空房间图，模糊、阈值，再用粗一级的模糊去掉细线：得到她的剪影，
 *   换姿势时只重画她那一块，新手流程里只给她上色。精修图之间有轻微漂移，所以先模糊再比。
 * - STAMP：笔刷印章。铅笔是圆的、取最大值；颜色是沿笔画方向拉长的毛边笔刷、相加叠色，可以用遮罩限定在一件家具里。
 * - COMPOSITE：每帧合成。颜色聚在她周围、往外褪成铅笔（美术规格 §6.4）；上色时颜色只在笔触扫过的地方，
 *   笔触边缘颜料堆积（颜色乘自身：压深不改色相），画完收干补满。2026-10-16 用户看过从一点往外扩的晕染，
 *   觉得不像画画，改成一笔一笔地画。
 */

export const VERTEX = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

export const EXTRACT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 outColor;

float luma(vec2 uv) { return dot(texture(uImage, uv).rgb, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

void main() {
  vec2 uv0 = vec2(vUv.x, 1.0 - vUv.y);
  float g1 = 0.0, g2 = 0.0, w1 = 0.0, w2 = 0.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 o = vec2(float(x), float(y));
      float r2 = dot(o, o);
      float l = luma(uv0 + o * uTexel);
      float a = exp(-r2 * 0.5);
      float b = exp(-r2 / (2.0 * 1.6 * 1.6));
      g1 += l * a; w1 += a;
      g2 += l * b; w2 += b;
    }
  }
  g1 /= w1;
  g2 /= w2;
  float line = smoothstep(0.010, 0.055, g2 - g1);
  float tone = (1.0 - smoothstep(0.30, 0.92, luma(uv0))) * 0.20;
  float grain = hash(floor(uv0 / uTexel * 0.5));
  outColor = vec4(max(line, tone) * (0.70 + 0.30 * grain), line, 0.0, 1.0);
}`

export const DIFF = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uPose;
uniform sampler2D uEmpty;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 uv0 = vec2(vUv.x, 1.0 - vUv.y);
  vec3 d = textureLod(uPose, uv0, 2.5).rgb - textureLod(uEmpty, uv0, 2.5).rgb;
  outColor = vec4(smoothstep(0.05, 0.15, length(d)), 0.0, 0.0, 1.0);
}`

export const OPEN = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRaw;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 uv0 = vec2(vUv.x, 1.0 - vUv.y);
  // 粗一级的模糊：细的漂移线条被抹淡，她这一大块留下来；阈值放低一点，裹住头发边缘
  float m = textureLod(uRaw, uv0, 3.5).r;
  outColor = vec4(smoothstep(0.22, 0.5, m), 0.0, 0.0, 1.0);
}`

export const STAMP_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aStamp; // x, y（纹理坐标）、半径、强度
layout(location = 1) in vec2 aShape; // 方向（弧度）、长宽比
out vec2 vLocal;
out vec2 vWorld;
out float vStrength;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  float c = cos(aShape.x), s = sin(aShape.x);
  vec2 local = corner * vec2(aStamp.z * aShape.y, aStamp.z);
  vec2 p = aStamp.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  vLocal = corner;
  vWorld = p;
  vStrength = aStamp.w;
  gl_Position = vec4(p.x * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
}`

export const STAMP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uChannel;
uniform float uRagged;     // 0：干净的圆；越大，笔刷边缘越毛
uniform float uUseMask;
uniform sampler2D uMask;
in vec2 vLocal;
in vec2 vWorld;
in float vStrength;
out vec4 outColor;
float hash(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  // 毛边按画面位置取噪点：同一笔里相邻的印章边缘连得上，像笔毛拖出来的
  float n = vnoise(vWorld * 95.0) * 0.6 + vnoise(vWorld * 24.0) * 0.4;
  float d = length(vLocal) + (n - 0.5) * uRagged;
  float a = (1.0 - smoothstep(0.5, 1.0, d)) * vStrength;
  if (uUseMask > 0.5) a *= texture(uMask, vWorld).r;
  outColor = uChannel * a;
}`

export const COMPOSITE = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uPencil;
uniform sampler2D uPrev;
uniform sampler2D uReveal;   // R 房间铅笔、G 她的线稿、B 颜色画到哪里、A 真实颜色画到哪里（新手流程）
uniform sampler2D uEmptyPencil;
uniform sampler2D uHerMask;
uniform float uHasPrev;
uniform float uPrevAlpha;
uniform float uPaint;        // 1：颜色只在笔触扫过的地方
uniform float uIntro;        // 1：新手流程，铅笔层也按揭开遮罩显示
uniform float uKeepOutside;  // 1：换姿势时她以外的地方保持着色，只重画她
uniform float uDry;          // 湿边干到什么程度
uniform float uWet;
uniform vec2 uRevealTexel;
uniform vec2 uVigCenter;
uniform vec2 uVigRadius;
uniform vec3 uGraphite;
uniform float uPencilOpacity;
uniform sampler2D uGhostPencil; // 她出门：上一张姿势的铅笔线
uniform sampler2D uGhostMask;   // 上一张姿势里她的剪影
uniform float uGhostAlpha;
in vec2 vUv;
out vec4 outColor;

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
}
// 彩铅的简单颜色：取模糊的大块颜色（不要细节），降饱和、提亮，排线之间露出纸色
vec3 pencilColor(vec2 uv) {
  vec3 c = textureLod(uColor, uv, 3.0).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 soft = mix(mix(vec3(l), c, 0.6), vec3(1.0), 0.25);
  float hatch = smoothstep(0.35, 0.75, abs(fract((uv.x + uv.y * 0.85) * 120.0) - 0.5) * 2.0);
  return mix(soft, vec3(1.0), 0.32 * hatch);
}

void main() {
  vec2 uv = vUv;
  float fadeY = smoothstep(0.0, 0.07, uv.y) * (1.0 - smoothstep(0.88, 1.0, uv.y));
  float fadeX = smoothstep(0.0, 0.08, uv.x) * (1.0 - smoothstep(0.92, 1.0, uv.x));

  // 颜色聚在她周围：椭圆的边带一点水彩毛边
  float dv = length((uv - uVigCenter) / uVigRadius);
  if (dv > 0.5 && dv < 1.12) dv += warped(uv * 11.0) * 0.055;
  float vig = (1.0 - smoothstep(0.62, 1.0, dv)) * fadeY;

  vec4 reveal = texture(uReveal, uv);
  float paint = 1.0;
  float real = 1.0;
  float edge = 0.0;
  if (uPaint > 0.5) {
    paint = reveal.b;
    if (uKeepOutside > 0.5) paint = max(paint, 1.0 - texture(uHerMask, uv).r);
    if (uIntro > 0.5) real = reveal.a;
    // 笔触的边：覆盖变化快的地方颜料堆起来
    float gx = texture(uReveal, uv + vec2(uRevealTexel.x, 0.0)).b - texture(uReveal, uv - vec2(uRevealTexel.x, 0.0)).b;
    float gy = texture(uReveal, uv + vec2(0.0, uRevealTexel.y)).b - texture(uReveal, uv - vec2(0.0, uRevealTexel.y)).b;
    edge = smoothstep(0.03, 0.22, length(vec2(gx, gy))) * (1.0 - uDry) * step(0.02, paint);
  }

  vec4 color = texture(uColor, uv);
  // 交叉淡化（换表情、光线、她出门）：颜色层本身在两张图之间混，晕染边和铅笔线不变
  if (uHasPrev > 0.5 && uPaint < 0.5) color.rgb = mix(color.rgb, texture(uPrev, uv).rgb, uPrevAlpha);
  color.rgb = mix(pencilColor(uv), color.rgb, real);
  color.rgb = mix(color.rgb, color.rgb * color.rgb, 0.55 * uWet * edge);
  // 颜料薄的地方透出纸纹
  float grain = 0.86 + 0.14 * vnoise(uv * 420.0);
  float coverage = smoothstep(0.0, 0.8, paint);
  float a = vig * mix(coverage * grain, 1.0, step(0.999, coverage)) * mix(0.88, 1.0, real);

  float lines = texture(uPencil, uv).r;
  if (uIntro > 0.5) lines = mix(texture(uEmptyPencil, uv).r * reveal.r, lines, reveal.g);
  float pencil = lines * uPencilOpacity * fadeX * fadeY;

  vec4 outp = vec4(uGraphite * pencil, pencil);
  // 换姿势：旧图垫在下面，新颜色画到哪里盖到哪里
  if (uHasPrev > 0.5 && uPaint > 0.5) {
    float pa = vig * uPrevAlpha;
    outp = vec4(texture(uPrev, uv).rgb * pa, pa) + outp * (1.0 - pa);
  }
  outColor = vec4(color.rgb * a, a) + outp * (1.0 - a);
  // 她的铅笔影子盖在最上面：颜色已经跟她走了，线还留一会儿
  if (uGhostAlpha > 0.0) {
    float g = texture(uGhostPencil, uv).r * texture(uGhostMask, uv).r * uGhostAlpha * uPencilOpacity * fadeX * fadeY;
    outColor = vec4(uGraphite * g, g) + outColor * (1.0 - g);
  }
}`

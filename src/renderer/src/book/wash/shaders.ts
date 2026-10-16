/**
 * 晕染用的两段着色器（WebGL2）。赛前练习页只留下做法和参数（体验设计 §7.1），这里赛中重写。
 *
 * - EXTRACT：每张整景图只跑一次，按原图分辨率提取铅笔层。用两级高斯模糊的差（DoG）找“比周围暗的细线”，
 *   不管整体明暗，夜图也能提出线；暗处再叠一层很淡的调子，乘上纸纹颗粒。2026-10-16 用户批准：
 *   精修图和旧线稿不再对齐，铅笔底先由着色器从彩图实时提取，天然逐像素对齐。
 * - COMPOSITE：每帧合成。颜色聚在她周围、往外褪成铅笔（美术规格 §6.4）；晕染时颜色从一点长开，
 *   前沿带域扭曲的分形噪点，湿边上颜料堆积（颜色乘自身：压深不改色相，白处仍是白），到点前湿边干掉。
 *   噪点只在前沿附近一条带里算。输出预乘 alpha，叠在书页的纸色上。
 */

export const VERTEX = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  // 一个盖住全屏的三角形；纹理第一行是图的顶边
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
  // 画进帧缓冲时第 0 行在底下：这里把纵向翻回来，铅笔层的行序才和原图纹理一致
  vec2 uv0 = vec2(vUv.x, 1.0 - vUv.y);
  // 两级高斯：sigma 1.0 和 1.6 像素（7×7 取样）
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
  // 线芯比四周暗：宽模糊减窄模糊为正
  float line = smoothstep(0.010, 0.055, g2 - g1);
  float tone = (1.0 - smoothstep(0.30, 0.92, luma(uv0))) * 0.20;
  float grain = hash(floor(uv0 / uTexel * 0.5));
  float pencil = max(line, tone) * (0.70 + 0.30 * grain);
  outColor = vec4(pencil, line, 0.0, 1.0);
}`

/** 新手流程揭开铅笔层的笔刷：实例化画一个个柔边圆，按通道取最大值累积（R 房间、G 她） */
export const STAMP_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aStamp; // x, y（纹理坐标）、半径、强度
out vec2 vLocal;
out float vStrength;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vLocal = corner;
  vStrength = aStamp.w;
  vec2 p = aStamp.xy + corner * aStamp.z;
  // 帧缓冲第 0 行在底下，对应纹理坐标 y = 0：和合成时的取样方向一致
  gl_Position = vec4(p.x * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
}`

export const STAMP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uChannel;
in vec2 vLocal;
in float vStrength;
out vec4 outColor;
void main() {
  float a = (1.0 - smoothstep(0.45, 1.0, length(vLocal))) * vStrength;
  outColor = uChannel * a;
}`

export const COMPOSITE = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uPencil;
uniform sampler2D uPrev;
uniform float uHasPrev;      // 换图时旧的那张颜色还在淡出
uniform float uPrevAlpha;
uniform float uWashOn;       // 1：颜色正在长开；0：已经铺满
uniform vec2 uOrigin;        // 晕开的起点（纹理坐标）
uniform float uRadius;       // 前沿半径（纹理坐标单位）
uniform float uNoiseAmp;     // 前沿噪点强度（纹理坐标单位）
uniform float uWet;          // 湿润感 0–1：0 像剪纸，1 发毛，0.5–0.6 最像水彩
uniform float uDry;          // 湿边干掉的程度 0–1
uniform float uSeed;
uniform vec2 uVigCenter;     // 颜色聚拢的椭圆
uniform vec2 uVigRadius;
uniform vec3 uGraphite;
uniform float uPencilOpacity;
uniform float uRealRadius;   // 之内是真实颜色，之外是彩铅的简单颜色（新手流程）；平时很大
uniform vec2 uWashShape;     // 晕开的形状：平时是圆，新手流程里竖长，裹住她的手
uniform float uIntro;        // 1：新手流程，铅笔层按揭开遮罩显示
uniform sampler2D uReveal;   // R：房间的铅笔画到哪里；G：她的线稿画到哪里
uniform sampler2D uEmptyPencil;
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
// 域扭曲的分形噪点，约在 -1..1
float warped(vec2 p) {
  vec2 q = vec2(fbm(p + uSeed), fbm(p + vec2(5.2, 1.3) + uSeed));
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

  // 颜色聚在她周围：椭圆的边也带一点水彩的毛边（每 1000 px 约 9 个周期）
  float dv = length((uv - uVigCenter) / uVigRadius);
  if (dv > 0.5 && dv < 1.12) dv += warped(uv * 11.0) * 0.055;
  float vig = (1.0 - smoothstep(0.62, 1.0, dv)) * fadeY;

  // 正在长开的颜色：r = rmax(1 - e^(-kt)) 由 CPU 算好传进来
  float wash = 1.0;
  float real = 1.0;
  float edge = 0.0;
  if (uWashOn > 0.5) {
    float soft = mix(0.0025, 0.036, uWet);
    float d0 = length((uv - uOrigin) * uWashShape);
    float near = min(abs(d0 - uRadius), abs(d0 - uRealRadius));
    float d = near < uNoiseAmp + soft + 0.02 ? d0 + warped(uv * 11.0 + 3.7) * uNoiseAmp : d0;
    wash = 1.0 - smoothstep(uRadius - soft, uRadius + soft, d);
    real = 1.0 - smoothstep(uRealRadius - soft, uRealRadius + soft, d + 0.004);
    float band = soft * 2.2 + 0.004;
    edge = max(exp(-pow((d - uRadius) / band, 2.0)) * wash, 0.7 * exp(-pow((d - uRealRadius) / band, 2.0)) * real) * (1.0 - uDry);
  }

  vec4 color = texture(uColor, uv);
  color.rgb = mix(pencilColor(uv), color.rgb, real);
  color.rgb = mix(color.rgb, color.rgb * color.rgb, 0.55 * uWet * edge);
  float a = vig * wash * mix(0.88, 1.0, real);

  float lines = texture(uPencil, uv).r;
  if (uIntro > 0.5) {
    // 先画空房间，再勾出她：她那块从空房间的线换成有她的线
    vec2 reveal = texture(uReveal, uv).rg;
    lines = mix(texture(uEmptyPencil, uv).r * reveal.r, lines, reveal.g);
  }
  float pencil = lines * uPencilOpacity * fadeX * fadeY;
  vec4 outp = vec4(uGraphite * pencil, pencil);
  if (uHasPrev > 0.5) {
    float pa = vig * uPrevAlpha;
    outp = vec4(texture(uPrev, uv).rgb * pa, pa) + outp * (1.0 - pa);
  }
  outColor = vec4(color.rgb * a, a) + outp * (1.0 - a);
}`

// Core image filter, a port of WG's Scripts/blender/photo_prop.py (build_lut, apply_lut, ps1_dither).
// Images are { w, h, data: Float32Array RGBA 0..1, sRGB }. No DOM here, so Node can test it.

export const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map(r => r.map(v => (v + 0.5) / 16));

export const WG_PALETTE = [
  ["green_black", "#0E1613"], ["blue_black", "#11161F"], ["violet_black", "#1C1D26"],
  ["slate", "#36434B"], ["rock_grey", "#5F6E78"], ["lavender_grey", "#8E8FA6"], ["moss", "#4F5E45"],
  ["fog_teal", "#5FA5B0"], ["fixture_6500k", "#D9ECFF"],
  ["rust_ground", "#6B3F25"], ["brick", "#6E4A3F"], ["practical_3000k", "#F2B66B"],
  ["train_window", "#E9A25A"], ["flower_orange", "#D8582B"], ["signal_red", "#C23A2A"],
];

export const WG_LUT = { gain: 0.8, saturation: 1.3, hue_weight: 4.0, softness: 0.002, snap_light: 0.6, snap_color: 0.9 };

export const PRESETS = {
  "WG Palette": { lut: { ...WG_LUT }, swatches: null, bits: 5 },
  "WG Tent": {
    lut: { gain: 0.8, saturation: 1.3, hue_weight: 10.0, softness: 0.025, snap_light: 0.3, snap_color: 0.75 },
    swatches: ["practical_3000k", "fixture_6500k", "fog_teal", "slate", "rock_grey", "green_black", "blue_black"],
    bits: 4,
  },
};

export function hexRgb(h) {
  return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}

export function srgbToOklab(r, g, b) {
  const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lr = lin(r), lg = lin(g), lb = lin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function oklabToSrgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const clip = v => Math.min(1, Math.max(0, v));
  const enc = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  return [
    enc(clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    enc(clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    enc(clip(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)),
  ];
}

// Palette LUT in the UE strip layout (width size*size, height size; x = r + size*b, y = g), RGB floats.
// Each lattice colour is scaled in OKLab by gain/saturation, then pulled toward a soft-nearest blend of the
// palette: snap_light of the way in lightness, snap_color in hue/chroma (hue counts hue_weight x lightness).
export function buildLut(opts, paletteHex, size = 16) {
  const o = { ...WG_LUT, ...opts };
  const pal = paletteHex.map(h => srgbToOklab(...hexRgb(h)));
  const strip = new Float32Array(size * size * size * 3);
  const dist = new Float64Array(pal.length);
  for (let g = 0; g < size; g++) for (let b = 0; b < size; b++) for (let r = 0; r < size; r++) {
    const lab = srgbToOklab(r / (size - 1), g / (size - 1), b / (size - 1));
    lab[0] *= o.gain; lab[1] *= o.saturation; lab[2] *= o.saturation;
    let min = Infinity;
    pal.forEach((p, i) => {
      const dL = lab[0] - p[0], da = lab[1] - p[1], db = lab[2] - p[2];
      dist[i] = dL * dL + o.hue_weight * (da * da + db * db);
      min = Math.min(min, dist[i]);
    });
    let wsum = 0;
    const t = [0, 0, 0];
    pal.forEach((p, i) => {
      const w = Math.exp(-(dist[i] - min) / o.softness);
      wsum += w; t[0] += w * p[0]; t[1] += w * p[1]; t[2] += w * p[2];
    });
    lab[0] += (t[0] / wsum - lab[0]) * o.snap_light;
    lab[1] += (t[1] / wsum - lab[1]) * o.snap_color;
    lab[2] += (t[2] / wsum - lab[2]) * o.snap_color;
    strip.set(oklabToSrgb(...lab), ((g * size + b) * size + r) * 3);
  }
  return { size, strip };
}

// Strip from an RGBA image of a UE LUT (height = size, width = size^2).
export function lutFromImage(img) {
  const size = img.h;
  if (img.w !== size * size) throw new Error(`LUT must be ${size * size}x${size} (UE strip layout), got ${img.w}x${img.h}`);
  const strip = new Float32Array(size * size * size * 3);
  for (let i = 0; i < size * size * size; i++) strip.set(img.data.subarray(i * 4, i * 4 + 3), i * 3);
  return { size, strip };
}

export function lutToImage({ size, strip }) {
  const w = size * size, h = size, data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data.set(strip.subarray(i * 3, i * 3 + 3), i * 4); data[i * 4 + 3] = 1; }
  return { w, h, data };
}

// Trilinear lookup, alpha untouched.
export function applyLut(img, { size, strip }) {
  const out = new Float32Array(img.data);
  const at = (r, g, b, c) => strip[((g * size + b) * size + r) * 3 + c];
  for (let p = 0; p < img.w * img.h; p++) {
    const i0 = [0, 0, 0], f = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, img.data[p * 4 + c])) * (size - 1);
      i0[c] = Math.min(size - 2, Math.max(0, Math.floor(v)));
      f[c] = v - i0[c];
    }
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let db = 0; db < 2; db++) for (let dg = 0; dg < 2; dg++) for (let dr = 0; dr < 2; dr++) {
        const w = (db ? f[2] : 1 - f[2]) * (dg ? f[1] : 1 - f[1]) * (dr ? f[0] : 1 - f[0]);
        acc += w * at(i0[0] + dr, i0[1] + dg, i0[2] + db, c);
      }
      out[p * 4 + c] = acc;
    }
  }
  return { w: img.w, h: img.h, data: out };
}

// 4x4 Bayer ordered dither to `bits` per channel (PS1 15-bit style at 5). alpha: "opaque" | "keep" | "cutout".
export function ps1Dither(img, bits, alpha = "opaque") {
  const levels = (1 << bits) - 1, out = new Float32Array(img.data);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const p = (y * img.w + x) * 4, thr = BAYER4[y % 4][x % 4];
    for (let c = 0; c < 3; c++) out[p + c] = Math.floor(Math.min(1, Math.max(0, img.data[p + c])) * levels + thr) / levels;
    if (alpha === "opaque") out[p + 3] = 1;
    else if (alpha === "cutout") out[p + 3] = img.data[p + 3] >= 0.5 ? 1 : 0;
  }
  return { w: img.w, h: img.h, data: out };
}

// Area-average downscale to w x h (alpha-weighted so transparent pixels don't bleed their colour).
export function boxResize(img, w, h) {
  if (w === img.w && h === img.h) return img;
  const out = new Float32Array(w * h * 4), sx = img.w / w, sy = img.h / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = x * sx, x1 = x0 + sx, y0 = y * sy, y1 = y0 + sy;
    let a = 0, wsum = 0;
    const rgb = [0, 0, 0];
    for (let yy = Math.floor(y0); yy < Math.min(img.h, Math.ceil(y1)); yy++) {
      const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
      for (let xx = Math.floor(x0); xx < Math.min(img.w, Math.ceil(x1)); xx++) {
        const wt = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx)), p = (yy * img.w + xx) * 4;
        const pa = img.data[p + 3] * wt;
        rgb[0] += img.data[p] * pa; rgb[1] += img.data[p + 1] * pa; rgb[2] += img.data[p + 2] * pa;
        a += pa; wsum += wt;
      }
    }
    const q = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) out[q + c] = a > 0 ? rgb[c] / a : 0;
    out[q + 3] = a / wsum;
  }
  return { w, h, data: out };
}

export function nearestScale(img, k) {
  if (k === 1) return img;
  const w = img.w * k, h = img.h * k, out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    out.set(img.data.subarray(((y / k | 0) * img.w + (x / k | 0)) * 4, ((y / k | 0) * img.w + (x / k | 0)) * 4 + 4), (y * w + x) * 4);
  return { w, h, data: out };
}

// Whole filter: downscale -> LUT -> dither -> nearest upscale.
export function processImage(img, { workW, workH, lut, bits, alpha, upscale }) {
  let work = boxResize(img, workW, workH);
  if (lut) work = applyLut(work, lut);
  work = ps1Dither(work, bits, alpha);
  return nearestScale(work, upscale);
}

import * as D from "./dither.js";
import { initVideo } from "./video.js";

const $ = id => document.getElementById(id);
const LUT_KEYS = ["gain", "saturation", "hue_weight", "softness", "snap_light", "snap_color"];
const STORE = "texture-dither-settings";

const state = {
  preset: "WG Palette",
  sizeMode: "div", div: 2, width: 128, upscale: 1, matchSize: false,
  bits: 5, alpha: "opaque",
  lutMode: "palette", lut: { ...D.WG_LUT },
  palette: D.WG_PALETTE.map(([name, hex]) => ({ name, hex, on: true })),
};
let images = [];          // { name, img, out }
let current = -1;
let fileLut = null, lutCache = null, lutKey = "";
let mode = "images";      // "images" | "video"
let shown = null;         // [src, out] on the stage
let video = null;

// ---------- settings

function applyPreset(name) {
  const p = D.PRESETS[name];
  state.preset = name;
  state.lut = { ...D.WG_LUT, ...p.lut };
  state.bits = p.bits;
  state.palette = D.WG_PALETTE.map(([n, hex]) => ({ name: n, hex, on: !p.swatches || p.swatches.includes(n) }));
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null");
    if (saved) Object.assign(state, saved, { lutMode: saved.lutMode === "file" ? "palette" : saved.lutMode });
  } catch { /* storage unavailable */ }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

// ---------- UI binding

const fmt = { softness: v => v.toFixed(4), div: v => `÷${v}`, upscale: v => `×${v}`, width: v => `${v}px`, bits: v => `${v}` };

function syncUi() {
  $("preset").value = state.preset;
  for (const k of ["sizeMode", "alpha", "lutMode"]) $(k).value = state[k];
  for (const k of ["div", "width", "upscale", "bits"]) { $(k).value = state[k]; $(k + "V").textContent = fmt[k](state[k]); }
  $("matchSize").checked = state.matchSize;
  $("upscale").disabled = state.matchSize;
  $("divRow").hidden = state.sizeMode !== "div";
  $("widthRow").hidden = state.sizeMode !== "width";
  for (const k of LUT_KEYS) {
    const v = state.lut[k];
    $(k).value = k === "softness" ? Math.log10(v) : v;
    $(k + "V").textContent = fmt[k] ? fmt[k](v) : v.toFixed(2);
  }
  $("paletteBox").hidden = state.lutMode !== "palette";
  $("fileBox").hidden = state.lutMode !== "file";
  renderSwatches();
}

function renderSwatches() {
  const box = $("swatches");
  box.replaceChildren(...state.palette.map((s, i) => {
    const el = document.createElement("div");
    el.className = "sw" + (s.on ? "" : " off");
    const col = Object.assign(document.createElement("input"), { type: "color", value: s.hex, title: s.hex });
    col.oninput = () => { s.hex = col.value.toUpperCase(); col.title = s.hex; changed(); };
    const name = Object.assign(document.createElement("span"), { className: "name", textContent: s.name, title: `${s.name} ${s.hex} — click to toggle` });
    name.style.cursor = "pointer";
    name.onclick = () => { s.on = !s.on; renderSwatches(); changed(); };
    const x = Object.assign(document.createElement("button"), { className: "x", textContent: "×", title: "Remove" });
    x.onclick = () => { state.palette.splice(i, 1); renderSwatches(); changed(); };
    el.append(col, name, x);
    return el;
  }));
}

function bind() {
  $("preset").replaceChildren(...Object.keys(D.PRESETS).map(n => new Option(n, n)));
  $("preset").onchange = () => { applyPreset($("preset").value); syncUi(); changed(); };
  $("resetPreset").onclick = () => { applyPreset(state.preset); syncUi(); changed(); };
  for (const k of ["sizeMode", "alpha", "lutMode"]) $(k).onchange = () => { state[k] = $(k).value; syncUi(); changed(); };
  for (const k of ["div", "width", "upscale", "bits"]) $(k).oninput = () => { state[k] = +$(k).value; syncUi(); changed(); };
  $("matchSize").onchange = () => { state.matchSize = $("matchSize").checked; syncUi(); changed(); };
  for (const k of LUT_KEYS) $(k).oninput = () => {
    const v = +$(k).value;
    state.lut[k] = k === "softness" ? +(10 ** v).toPrecision(3) : v;
    syncUi(); changed();
  };
  $("addSwatch").onclick = () => { state.palette.push({ name: `custom_${state.palette.length + 1}`, hex: "#808080", on: true }); renderSwatches(); changed(); };
  $("lutFile").onchange = async () => {
    const f = $("lutFile").files[0];
    if (!f) return;
    try { fileLut = D.lutFromImage(await decode(f)); changed(); } catch (e) { alert(e.message); }
  };
  $("saveLut").onclick = () => { const l = getLut(); if (l) downloadImage(D.lutToImage(l), "LUT_Dither.png"); };

  $("exportCfg").onclick = () => {
    const blob = new Blob([JSON.stringify({ ...state, lutMode: state.lutMode === "file" ? "palette" : state.lutMode }, null, 2)], { type: "application/json" });
    downloadBlob(blob, "texture-dither.json");
  };
  $("importCfg").onclick = () => $("cfgFile").click();
  $("cfgFile").onchange = async () => {
    const f = $("cfgFile").files[0];
    if (!f) return;
    try { Object.assign(state, JSON.parse(await f.text())); syncUi(); changed(); } catch (e) { alert("Bad settings file: " + e.message); }
  };

  for (const b of document.querySelectorAll("[data-mode]")) b.onclick = () => setMode(b.dataset.mode);
  $("open").onclick = () => $("files").click();
  $("files").onchange = () => addFiles($("files").files);
  $("zoom").onchange = layout;
  $("showSrc").onchange = () => { $("srcFig").hidden = !$("showSrc").checked; layout(); };
  $("dl").onclick = () => { const it = images[current]; if (it?.out) downloadImage(it.out, outName(it.name)); };
  $("dlAll").onclick = async () => {
    for (const it of images) { ensureOut(it); downloadImage(it.out, outName(it.name)); await new Promise(r => setTimeout(r, 250)); }
  };

  const stage = $("stage");
  stage.ondragover = e => { e.preventDefault(); stage.classList.add("over"); };
  stage.ondragleave = () => stage.classList.remove("over");
  stage.ondrop = e => { e.preventDefault(); stage.classList.remove("over"); addFiles(e.dataTransfer.files); };
  window.addEventListener("paste", e => {
    const files = [...e.clipboardData.items].filter(i => i.kind === "file").map(i => i.getAsFile()).filter(Boolean);
    if (files.length) addFiles(files);
  });
  window.addEventListener("resize", layout);
}

// ---------- processing

function getLut() {
  if (state.lutMode === "off") return null;
  if (state.lutMode === "file") return fileLut;
  const hexes = state.palette.filter(s => s.on).map(s => s.hex);
  if (!hexes.length) return null;
  const key = JSON.stringify([state.lut, hexes]);
  if (key !== lutKey) { lutCache = D.buildLut(state.lut, hexes); lutKey = key; }
  return lutCache;
}

function params(img) {
  let workW = img.w, workH = img.h;
  if (state.sizeMode === "div") { workW = Math.max(1, Math.round(img.w / state.div)); workH = Math.max(1, Math.round(img.h / state.div)); }
  else if (state.sizeMode === "width") { workW = Math.min(img.w, state.width); workH = Math.max(1, Math.round(img.h * workW / img.w)); }
  const upscale = state.matchSize ? Math.max(1, Math.round(img.w / workW)) : state.upscale;
  return { workW, workH, lut: getLut(), bits: state.bits, alpha: state.alpha, upscale };
}

function ensureOut(it) {
  if (!it.out) it.out = D.processImage(it.img, params(it.img));
}

let pending = 0;
function changed() {
  save();
  drawLutPreview();
  for (const it of images) it.out = null;
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(show);
}

function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll("[data-mode]")) b.classList.toggle("sel", b.dataset.mode === m);
  show();
}

function drawLutPreview() {
  const l = getLut(), cv = $("lutPrev");
  if (!l) { cv.hidden = true; return; }
  cv.hidden = false;
  paint(cv, D.lutToImage(l));
}

// ---------- images

async function decode(file) {
  const bmp = await createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext("2d", { colorSpace: "srgb" });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  return { w: bmp.width, h: bmp.height, data: Float32Array.from(px, v => v / 255) };
}

async function addFiles(list) {
  const clip = [...list].find(f => f.type.startsWith("video/"));
  if (clip) { setMode("video"); await video.open(clip); return; }
  if (mode === "video") setMode("images");
  for (const f of list) {
    if (!f.type.startsWith("image/")) continue;
    try { images.push({ name: f.name || "pasted.png", img: await decode(f), out: null }); }
    catch (e) { alert(`${f.name}: ${e.message}`); }
  }
  if (current < 0 && images.length) current = 0;
  else if (images.length) current = images.length - 1;
  renderFileList();
  show();
}

function renderFileList() {
  $("fileList").replaceChildren(...images.map((it, i) => {
    const b = document.createElement("button");
    b.className = i === current ? "sel" : "";
    b.textContent = it.name;
    const x = document.createElement("span");
    x.textContent = "×"; x.title = "Remove"; x.style.opacity = ".6";
    x.onclick = e => { e.stopPropagation(); images.splice(i, 1); current = Math.min(current, images.length - 1); renderFileList(); show(); };
    b.append(x);
    b.onclick = () => { current = i; renderFileList(); show(); };
    return b;
  }));
  $("dl").disabled = current < 0;
  $("dlAll").disabled = images.length < 2;
}

function show() {
  const vid = mode === "video";
  $("imgBar").hidden = $("imgDl").hidden = $("fileList").hidden = $("dropImg").hidden = vid;
  $("vidBar").hidden = $("vidOpenBar").hidden = $("dropVid").hidden = !vid;
  if (vid) {
    if (!video.loaded()) showPair(null);
    else video.refresh();
    return;
  }
  const it = images[current];
  if (!it) { showPair(null); return; }
  ensureOut(it);
  const p = params(it.img);
  showPair(it.img, it.out, `${it.img.w}×${it.img.h} → ${p.workW}×${p.workH} · ${state.bits}-bit` + (p.upscale > 1 ? ` · ×${p.upscale}` : ""));
}

// Put a source/result pair on the stage (null clears it and shows the drop hint).
function showPair(src, out, info = "") {
  shown = src ? [src, out] : null;
  $("dropHint").hidden = !!src;
  $("views").hidden = !src;
  $("info").textContent = info;
  if (!src) return;
  paint($("srcCv"), src);
  paint($("outCv"), out);
  $("outCap").textContent = `Result ${out.w}×${out.h}`;
  layout();
}

function layout() {
  if (!shown) return;
  const [src, out] = shown;
  let z = +$("zoom").value;
  const showSrc = $("showSrc").checked;
  if (!z) {
    const st = $("stage"), cols = showSrc ? 2 : 1;
    const availW = (st.clientWidth - 32 - (cols - 1) * 16) / cols, availH = st.clientHeight - 56;
    z = Math.min(availW / out.w, availH / out.h);
    z = z >= 1 ? Math.floor(z) : z;
  }
  for (const [cv, im] of [[$("srcCv"), src], [$("outCv"), out]]) {
    const k = z * out.w / im.w;   // both shown at the result's on-screen size
    cv.style.width = `${im.w * k}px`;
    cv.style.height = `${im.h * k}px`;
  }
}

function toImageData(img) {
  const u8 = new Uint8ClampedArray(img.w * img.h * 4);
  for (let i = 0; i < u8.length; i++) u8[i] = Math.round(img.data[i] * 255);
  return new ImageData(u8, img.w, img.h);
}

function paint(cv, img) {
  cv.width = img.w; cv.height = img.h;
  cv.getContext("2d").putImageData(toImageData(img), 0, 0);
}

function outName(name) { return name.replace(/\.[^.]+$/, "") + "_dither.png"; }

function toPng(img) {
  const cv = document.createElement("canvas");
  paint(cv, img);
  return new Promise(ok => cv.toBlob(ok, "image/png"));
}

async function downloadImage(img, name) {
  downloadBlob(await toPng(img), name);
}

function downloadBlob(blob, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

load();
video = initVideo({ params, showPair, toPng, download: downloadBlob });
bind();
syncUi();
changed();
show();

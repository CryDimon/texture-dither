// Video mode: seek the clip frame by frame, run each frame through the same filter, encode H.264 MP4
// (WebCodecs + mp4-muxer) or zip a lossless PNG sequence (fflate). Libraries load on first export.
import * as D from "./dither.js";

const MUXER_URL = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.mjs";
const ZIP_URL = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
const AVC_CODECS = ["avc1.640034", "avc1.640033", "avc1.64002a", "avc1.4d0034", "avc1.42003e"];
const $ = id => document.getElementById(id);

export function initVideo(ctx) {
  const video = Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" });
  const grabCv = new OffscreenCanvas(1, 1);
  let name = "", busy = false, cancel = false, previewToken = 0;

  const loaded = () => !!name && video.readyState >= 1;

  async function open(file) {
    if (video.src) URL.revokeObjectURL(video.src);
    name = file.name || "video.mp4";
    video.src = URL.createObjectURL(file);
    await new Promise((ok, fail) => { video.onloadedmetadata = ok; video.onerror = () => fail(new Error("This browser can't decode the file")); });
    const dur = video.duration;
    $("vScrub").max = dur; $("vScrub").value = 0;
    $("vStart").value = 0; $("vEnd").value = +dur.toFixed(2);
    $("vStart").max = $("vEnd").max = dur.toFixed(2);
    updateLabels();
    await refresh();
  }

  async function seek(t) {
    if (Math.abs(video.currentTime - t) > 1e-4 || video.readyState < 2) {
      await new Promise(ok => { video.onseeked = ok; video.currentTime = t; });
    }
  }

  async function grab(t) {
    await seek(t);
    const w = video.videoWidth, h = video.videoHeight;
    if (grabCv.width !== w || grabCv.height !== h) { grabCv.width = w; grabCv.height = h; }
    const g = grabCv.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, 0, 0, w, h);
    return { w, h, data: Float32Array.from(g.getImageData(0, 0, w, h).data, v => v / 255) };
  }

  function frameCount() {
    const fps = +$("vFps").value, s = +$("vStart").value, e = +$("vEnd").value;
    return Math.max(1, Math.round((e - s) * fps));
  }

  function updateLabels() {
    $("vScrubV").textContent = `${(+$("vScrub").value).toFixed(2)}s`;
    $("vFrames").textContent = loaded() ? `${frameCount()} frames` : "";
  }

  // Re-render the frame under the scrubber (latest request wins).
  async function refresh() {
    if (!loaded() || busy) return;
    const token = ++previewToken;
    const src = await grab(+$("vScrub").value);
    if (token !== previewToken) return;
    const p = ctx.params(src);
    ctx.showPair(src, D.processImage(src, p), `${src.w}×${src.h} → ${p.workW}×${p.workH} · ${p.bits}-bit` + (p.upscale > 1 ? ` · ×${p.upscale}` : ""));
  }

  async function exportVideo() {
    if (!loaded() || busy) return;
    busy = true; cancel = false;
    setBusy(true);
    const fps = +$("vFps").value, start = +$("vStart").value, n = frameCount(), fmt = $("vFormat").value;
    const base = name.replace(/\.[^.]+$/, "") + "_dither";
    try {
      const sink = fmt === "mp4" ? await mp4Sink(fps) : await zipSink();
      for (let i = 0; i < n && !cancel; i++) {
        const t = Math.min(start + (i + 0.5) / fps, video.duration - 1e-3);
        const src = await grab(t);
        const out = D.processImage(src, ctx.params(src));
        await sink.add(out, i);
        if (i % 4 === 0 || i === n - 1) { ctx.showPair(src, out, `frame ${i + 1}/${n}`); progress((i + 1) / n); }
      }
      if (!cancel) ctx.download(await sink.finish(), `${base}.${fmt === "mp4" ? "mp4" : "zip"}`);
    } catch (e) {
      alert("Export failed: " + e.message);
    } finally {
      busy = false;
      setBusy(false);
      progress(0);
      refresh();
    }

    async function mp4Sink(fps) {
      if (!("VideoEncoder" in window)) throw new Error("this browser has no WebCodecs VideoEncoder — use PNG sequence");
      const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);
      let muxer, encoder, w, h, error;
      return {
        async add(img, i) {
          if (!encoder) {
            w = img.w & ~1; h = img.h & ~1;   // H.264 needs even sizes
            const bitrate = Math.min(80e6, Math.round(w * h * fps * 0.5));
            let config;
            for (const codec of AVC_CODECS) {
              const c = { codec, width: w, height: h, bitrate, framerate: fps, avc: { format: "avc" } };
              if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break; }
            }
            if (!config) throw new Error(`no H.264 encoder for ${w}×${h} — try a smaller size or PNG sequence`);
            muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: w, height: h, frameRate: fps }, fastStart: "in-memory" });
            encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { error = e; } });
            encoder.configure(config);
          }
          if (error) throw error;
          const rgba = new Uint8ClampedArray(w * h * 4);
          for (let y = 0; y < h; y++) for (let x = 0; x < w * 4; x++) rgba[y * w * 4 + x] = Math.round(img.data[y * img.w * 4 + x] * 255);
          for (let p = 3; p < rgba.length; p += 4) rgba[p] = 255;
          const frame = new VideoFrame(rgba, { format: "RGBA", codedWidth: w, codedHeight: h, timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
          encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
          frame.close();
          while (encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 5));
        },
        async finish() {
          await encoder.flush();
          if (error) throw error;
          muxer.finalize();
          return new Blob([muxer.target.buffer], { type: "video/mp4" });
        },
      };
    }

    async function zipSink() {
      const { zipSync } = await import(ZIP_URL);
      const files = {};
      return {
        async add(img, i) {
          const blob = await ctx.toPng(img);
          files[`${base}/frame_${String(i + 1).padStart(5, "0")}.png`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
        },
        async finish() { return new Blob([zipSync(files)], { type: "application/zip" }); },
      };
    }
  }

  function setBusy(on) {
    for (const id of ["vOpen", "vExport", "vScrub", "vFps", "vFormat", "vStart", "vEnd"]) $(id).disabled = on;
    $("vCancel").hidden = !on;
  }
  function progress(f) {
    $("vProgress").hidden = f <= 0;
    $("vProgress").value = f;
  }

  $("vOpen").onclick = () => $("vFile").click();
  $("vFile").onchange = () => { const f = $("vFile").files[0]; if (f) open(f).catch(e => alert(e.message)); };
  $("vScrub").oninput = () => { updateLabels(); refresh(); };
  for (const id of ["vFps", "vStart", "vEnd"]) $(id).oninput = updateLabels;
  $("vExport").onclick = exportVideo;
  $("vCancel").onclick = () => { cancel = true; };
  setBusy(false);

  return { open: f => open(f).catch(e => alert(e.message)), refresh, loaded };
}

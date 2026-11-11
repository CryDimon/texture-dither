# Texture Dither

PS1-style texture filter in the browser: downscale → palette LUT (OKLab soft-snap to a swatch palette) → 4×4 Bayer ordered dither → nearest upscale.

**Use it:** https://crydimon.github.io/texture-dither/

- Drop, paste or open images (several at once), tweak, download PNGs. Nothing is uploaded.
- Presets: *WG Palette* (the game's shared LUT) and *WG Tent*. Edit swatches, LUT parameters, bit depth, alpha handling.
- Load any UE-layout LUT strip (256×16), or download the generated one for use in Unreal.
- Settings export/import as JSON; last settings are remembered in the browser.

`dither.js` is a dependency-free port of WG's `Scripts/blender/photo_prop.py` (`build_lut`, `apply_lut`, `ps1_dither`); its output is bit-identical to the Python version.

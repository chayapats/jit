# Vendored fonts

Self-hosted variable WOFF2 files for the Jit visual system ([ADR 0028](../../../docs/adr/0028-progressive-enhancement-browser-assets.md), S09-D11). Each font is licensed under the SIL Open Font License 1.1; the license text ships next to it. Jit serves these files only from its own origin through the content-hashed asset table (`web.static_assets/v1`).

| File | Family / version | Official release | Source file in the release | Licence |
| --- | --- | --- | --- | --- |
| `Inter-Variable.woff2` | Inter 4.1 (`opsz` 14–32, `wght` 100–900) | [rsms/inter v4.1](https://github.com/rsms/inter/releases/tag/v4.1), `Inter-4.1.zip` sha256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e` | `web/InterVariable.woff2`, copied unchanged | `OFL-Inter.txt` |
| `NotoSansThai-Variable.woff2` | Noto Sans Thai 2.002 (`wght` 400–700, unhinted, Thai glyphs only) | [notofonts/thai NotoSansThai-v2.002](https://github.com/notofonts/thai/releases/tag/NotoSansThai-v2.002), `NotoSansThai-v2.002.zip` sha256 `af889cc673fc714060ce5e4e088fbad32aa4c0571a19958efeaff128a22da485` | `NotoSansThai/unhinted/slim-variable-ttf/NotoSansThai[wght].ttf` (sha256 `13f52f79…f7e7`), re-wrapped as WOFF2 | `OFL-NotoSansThai.txt` |
| `JetBrainsMono-Variable.woff2` | JetBrains Mono 2.304 (`wght` 100–800) | [JetBrains/JetBrainsMono v2.304](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304), `JetBrainsMono-2.304.zip` sha256 `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf` | `fonts/variable/JetBrainsMono[wght].ttf` (sha256 `662a196d…c016`), re-wrapped as WOFF2 | `OFL-JetBrainsMono.txt` |

The Noto Sans Thai and JetBrains Mono releases ship their variable fonts only as TTF. They were converted with fontTools 4.62 (`TTFont(src); font.flavor = "woff2"; font.save(dst)`). This is a lossless container change. Glyph outlines, names and axes are unchanged. Nothing else from the release archives is vendored.

Committed file hashes (sha256):

```
693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3  Inter-Variable.woff2
6111cfa9836303d5ef853d4da03f5a4da1eeba4a677d5649d6065da4925a00f0  NotoSansThai-Variable.woff2
6656c6eb124c97cac5487bf4fd38993510f36473e5d50e3fa08edd5c4aeb4c44  JetBrainsMono-Variable.woff2
```

The OFL forbids selling the fonts on their own and reserves the font names for unmodified versions. Re-wrapping is not a modification of the font software, so the names stay.

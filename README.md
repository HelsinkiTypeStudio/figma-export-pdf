# Export PDF with Real Text

A Figma plugin that exports frames and slides as PDFs with real, selectable text in your own fonts. Glyphs stay exactly where Figma put them, and no font is ever swapped for another.

Figma's own PDF export draws every letter as an outline. That makes text pages large and leaves the PDF without real fonts. This plugin keeps everything Figma draws, and replaces the outlines of checked text with the same text set in the font file installed on your Mac, subset to the letters used. Fonts that are rebuilt often, variable fonts and Glyphs test builds all work, because each export reads the font files fresh.

Works in Figma Design and Figma Slides.

## You need

- [Font Helper](https://github.com/HelsinkiTypeStudio/font-helper) running in your menu bar. It hands the installed font files to the plugin. Without it, the plugin still exports, but all text stays as outlines.
- The Figma desktop app.

## Install

```sh
git clone https://github.com/HelsinkiTypeStudio/figma-export-pdf.git
cd figma-export-pdf
npm install
npm run build
```

In Figma: **Plugins → Development → Import plugin from manifest…** and choose `manifest.json`.

## Use

1. Select the frames or slides to export. With nothing selected, it exports every slide (Slides) or every top-level frame on the page (Design).
2. Run **Export PDF with Real Text** and click **Export PDF**. The first time, Font Helper asks whether to allow the plugin.
3. Choose where to save. The dialog opens in the folder you used last.

The plugin window then lists which text stayed as Figma's outlines, and why.

## How it works

Your layers are never touched. For each frame or slide the plugin makes a temporary copy and exports it twice:

1. **Export A** is Figma's normal PDF. Besides the outlines, it holds an invisible text layer that records the exact position, size and characters of every glyph, plus each glyph's width and box.
2. Each line of that layer is matched to the text layer it came from. **Font Helper** checks every glyph against the installed font file, fixed at the variable font axis values Figma used: the width and the left, bottom and right edges must agree within one font unit.
3. **Export B** is made after clearing the fill of only the lines that passed. Figma still draws everything else exactly as before.
4. The checked lines are written into export B as real text, glyph by glyph at export A's positions, with Figma's own widths and the characters from Figma's character map, so copy and paste gives the same text as Figma's export.

## What stays as outlines

Text stays exactly as Figma drew it when:

- its font isn't installed, or a glyph doesn't match the installed file (for example a letter Figma took from a fallback font, or a build Figma hasn't reloaded yet);
- another layer covers it, or a frame or mask clips it (text cut off by the edge of the exported frame is fine);
- it has a gradient or image fill, more than one fill, a see-through fill, a stroke, effects, a blend mode, or sits in a see-through layer;
- it is underlined, struck through, or cut off with an ellipsis.

Outlined text still selects and copies as in Figma's own export.

## Development

```sh
npm run watch       # rebuilds on save
npm run typecheck
node test/run.mjs <exports folder> <fonts folder> <path to font-helper/Resources/fontwork.py> <output folder>
```

`test/run.mjs` runs the PDF side outside Figma, on exports saved by the figma-export-pdf test plugin.

## Licence

MIT

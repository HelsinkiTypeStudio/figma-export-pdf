# Export PDF optimised for presentations

A Figma plugin that exports frames and slides as PDFs with real, selectable text in your own fonts. Glyphs stay exactly where Figma put them, and no font is ever swapped for another.

Figma's own PDF export draws every letter as an outline. That makes text pages large and leaves the PDF without real fonts. This plugin keeps everything Figma draws, and replaces the outlines of checked text with the same text set in the font file installed on your Mac, subset to the letters used. Fonts that are rebuilt often, variable fonts and Glyphs test builds all work, because each export reads the font files fresh.

Works in Figma Design and Figma Slides.

## You need

- [Figma Friend](https://github.com/HelsinkiTypeStudio/font-helper) running in your menu bar. It hands the installed font files to the plugin. Without it, the plugin still exports, but all text stays as outlines.
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

1. In Slides, nothing needs selecting: every slide is exported. In Design, select the frames to export, or nothing for every top-level frame on the page.
2. Choose **Export PDF optimised for presentations** from the Actions menu. It starts straight away, with no window; progress shows at the bottom of the screen. The first time, Figma Friend asks whether to allow the plugin.
3. Choose where to save. The dialog opens in the folder you used last.

A progress bar shows at the bottom of the screen. At the end it says "PDF saved", or "Export failed" with a **Details** button. Which text stayed as outlines, and why, is written to the plugin console (Plugins › Development › Show/Hide Console).

## How it works

Nothing in your file changes, and nothing is copied. Each frame or slide is exported once, with Figma's own PDF export:

1. Figma's PDF holds, besides the letter outlines, an invisible text layer that records the exact position, size and characters of every glyph, plus each glyph's width and box.
2. Each line of that layer is matched to the text layer it came from. **Figma Friend** checks every glyph against the installed font file, fixed at the variable font axis values Figma used: the width and the left, bottom and right edges must agree within one font unit.
3. For the lines that passed, the plugin finds their letter outlines in Figma's PDF (each outline must sit inside its glyph's box, in the line's own colour) and takes them out. A line whose outlines can't all be found stays as it is.
4. Those lines are written back as real text, glyph by glyph at Figma's positions, with Figma's own widths and the characters from Figma's character map, so copy and paste gives the same text as Figma's export.

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

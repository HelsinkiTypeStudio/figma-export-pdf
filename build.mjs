// Bundles the plugin into dist/: code.js for the Figma side, and ui.html with the
// window's script (and pdf-lib) inlined, since a plugin window is a single HTML file.
// Pass --watch to rebuild on save.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";

mkdirSync("dist", { recursive: true });

const inlineUI = {
  name: "inline-ui",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
      const html = readFileSync("src/ui.html", "utf8").replace("/*UI_SCRIPT*/", () => js.replace(/<\/script/gi, "<\\/script"));
      writeFileSync("dist/ui.html", html);
    });
  },
};

const code = { entryPoints: ["src/code.ts"], bundle: true, outfile: "dist/code.js", target: "es2017", logLevel: "info" };
const ui = { entryPoints: ["src/ui.ts"], bundle: true, write: false, outfile: "dist/ui.js", target: "es2020", minify: true, plugins: [inlineUI], logLevel: "info" };

if (process.argv.includes("--watch")) {
  await (await esbuild.context(code)).watch();
  await (await esbuild.context(ui)).watch();
} else {
  await esbuild.build(code);
  await esbuild.build(ui);
}

// Bundles test/pipeline.ts for Node and runs it with the given arguments.
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";

await esbuild.build({
  entryPoints: ["test/pipeline.ts"], bundle: true, platform: "node", format: "esm",
  outfile: "test/.build/pipeline.mjs", logLevel: "warning",
});
const r = spawnSync(process.execPath, ["test/.build/pipeline.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);

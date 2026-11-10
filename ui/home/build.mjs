import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL(".", import.meta.url));
const web = resolve(root, "../../web");
const output = join(root, "node_modules/.cache/home-render.cjs");
mkdirSync(join(root, "node_modules/.cache"), { recursive: true });
await build({ entryPoints:[join(root,"home.tsx")], outfile:output, bundle:true, platform:"node", format:"cjs", jsx:"automatic", tsconfig:join(root,"tsconfig.json"), logLevel:"warning" });
const { renderHomeParts } = createRequire(import.meta.url)(output);
const parts = renderHomeParts();
writeFileSync(join(web,"ui-theme.js"), `// Generated BoardUI markup; rebuild through ui/home/build.mjs.\n(() => {\nconst uiParts = ${JSON.stringify(parts)};\n${readFileSync(join(root,"mount.js"),"utf8")}\n})();\n`);
execFileSync(process.execPath, [join(root,"node_modules/@tailwindcss/cli/dist/index.mjs"), "-i", join(root,"home.css"), "-o", join(web,"boardui-home.css"), "--minify"], {cwd:root,stdio:"inherit"});
console.log("Built the site-wide BoardUI styles and static components.");

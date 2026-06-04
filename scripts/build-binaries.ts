/**
 * Cross-compile single-file executables with Bun (`bun run scripts/build-binaries.ts`).
 * Produces standalone binaries in bin-dist/ that bundle the Bun runtime + presets,
 * so end users do not need Node, Bun, or npm install.
 */
import { $ } from "bun";

const targets = [
  { name: "linux-x64", target: "bun-linux-x64", ext: "" },
  { name: "linux-arm64", target: "bun-linux-arm64", ext: "" },
  { name: "darwin-x64", target: "bun-darwin-x64", ext: "" },
  { name: "darwin-arm64", target: "bun-darwin-arm64", ext: "" },
  { name: "windows-x64", target: "bun-windows-x64", ext: ".exe" },
];

const entry = "./src/index.ts";

for (const t of targets) {
  const out = `bin-dist/suber-agent-team-${t.name}${t.ext}`;
  console.log(`[build] ${t.target} -> ${out}`);
  await $`bun build ${entry} --compile --minify --target=${t.target} --outfile ${out}`;
}

console.log("[build] done. Binaries are in bin-dist/.");

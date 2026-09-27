// Builds the one-click Claude Desktop Extension: release/poe2-build-planner-<version>.mcpb
// Usage: npm run package

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const stage = join(root, "build", "mcpb");
const run = (cmd: string, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(`manifest.json version ${manifest.version} doesn't match package.json ${pkg.version}`);
}

run("npm run build");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(root, "dist"), join(stage, "server"), { recursive: true });
cpSync(join(root, "manifest.json"), join(stage, "manifest.json"));
cpSync(join(root, "README.md"), join(stage, "README.md"));
// Only runtime dependencies go in the bundle.
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", private: true, dependencies: pkg.dependencies }, null, 2),
);
cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", stage);

mkdirSync(join(root, "release"), { recursive: true });
const out = join(root, "release", `poe2-build-planner-${pkg.version}.mcpb`);
run(`npx mcpb validate "${join(stage, "manifest.json")}"`);
run(`npx mcpb pack "${stage}" "${out}"`);
console.log(`\nBuilt ${out}`);

// Builds the one-click Claude Desktop Extension: release/poe2-build-planner-<version>.mcpb
// Usage: npm run package
//
// The Path of Building engine (Windows) is included when available:
//   POE2BF_PACKAGE_ENGINE_DIR=<dir>  a ready engine/ folder (e.g. the CI "engine-windows" artifact)
//   otherwise vendor/runtime + vendor/pob from a local checkout (see docs/engine.md)

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
for (const file of ["manifest.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) cpSync(join(root, file), join(stage, file));
// Only runtime dependencies go in the bundle.
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", private: true, dependencies: pkg.dependencies }, null, 2),
);
cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", stage);

// Path of Building engine.
const engineOut = join(stage, "engine");
const prebuilt = process.env.POE2BF_PACKAGE_ENGINE_DIR;
const vendor = join(root, "vendor");
const skipArt = (src: string) => !/\.(zst|png|jpg|jpeg|dds|webp)$/i.test(src) && !/[\\/]\.git([\\/]|$)/.test(src) && !/[\\/]src[\\/]Export([\\/]|$)/.test(src);
if (prebuilt && existsSync(join(prebuilt, "host.lua"))) {
  cpSync(prebuilt, engineOut, { recursive: true });
  console.log(`Engine: from ${prebuilt}`);
} else if (existsSync(join(vendor, "runtime", "luajit.exe")) && existsSync(join(vendor, "pob", "src", "HeadlessWrapper.lua"))) {
  cpSync(join(vendor, "runtime"), join(engineOut, "runtime"), { recursive: true });
  cpSync(join(vendor, "pob", "src"), join(engineOut, "pob", "src"), { recursive: true, filter: skipArt });
  cpSync(join(vendor, "pob", "runtime", "lua"), join(engineOut, "pob", "runtime", "lua"), { recursive: true });
  cpSync(join(root, "pob", "host.lua"), join(engineOut, "host.lua"));
  mkdirSync(join(engineOut, "licenses"), { recursive: true });
  cpSync(join(vendor, "pob", "LICENSE.md"), join(engineOut, "licenses", "PathOfBuilding-LICENSE.md"));
  console.log("Engine: from vendor/");
} else {
  console.warn("Engine: not found — the bundle will work without Path of Building numbers (evaluate_build reports unavailable).");
}

mkdirSync(join(root, "release"), { recursive: true });
const out = join(root, "release", `poe2-build-planner-${pkg.version}.mcpb`);
run(`npx mcpb validate "${join(stage, "manifest.json")}"`);
run(`npx mcpb pack "${stage}" "${out}"`);
console.log(`\nBuilt ${out}`);

#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const preview = process.argv.includes("--preview");
if (process.argv.slice(2).some((arg) => arg !== "--preview")) {
  throw new Error("Usage: node scripts/build-ko-release.mjs [--preview]");
}
function run(command, args, cwd = root, capture = false, env = process.env) {
  // Invoke Corepack through Node on Windows, without cmd.exe argument interpolation.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build bootstrap.
  if (command === "corepack" && process.platform === "win32") {
    const found = NodeChildProcess.spawnSync("where.exe", ["corepack.cmd"], { encoding: "utf8" });
    const shim = found.stdout?.trim().split(/\r?\n/)[0];
    if (!shim) throw new Error("Corepack is not installed on PATH.");
    const entry = NodePath.join(NodePath.dirname(shim), "node_modules/corepack/dist/corepack.js");
    if (!NodeFS.existsSync(entry)) throw new Error(`Cannot find Corepack entry: ${entry}`);
    command = process.execPath;
    args = [entry, ...args];
  }
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout?.trim();
}
function readEnv(name) {
  try {
    return NodeUtil.parseEnv(NodeFS.readFileSync(NodePath.join(root, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
const env = {
  ...readEnv(".env"),
  ...readEnv(".env.local"),
  ...process.env,
  pnpm_config_verify_deps_before_run: "error",
  npm_config_frozen_lockfile: "true",
};
for (const name of ["VITE_HTTP_URL", "VITE_WS_URL"]) {
  if (env[name]) throw new Error(`${name} must be unset: fleet clients use their own origin.`);
}
const commit = run("git", ["rev-parse", "HEAD"], root, true);
const dirty = Boolean(
  run("git", ["status", "--porcelain", "--untracked-files=normal"], root, true),
);
if (dirty && !preview)
  throw new Error(
    "Commit the fork changes before releasing, or use --preview for local validation.",
  );
if (!preview) {
  const published = run(
    "git",
    ["ls-remote", "https://github.com/nobody0/t3code.git", "refs/heads/main"],
    root,
    true,
  );
  if (published.split(/\s+/)[0] !== commit)
    throw new Error(
      "Publish the reviewed commit to nobody0/t3code main before building a fleet release.",
    );
}
const version = JSON.parse(
  NodeFS.readFileSync(NodePath.join(root, "apps/server/package.json"), "utf8"),
).version;
if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Invalid package version.");
const releaseId = `${version}-ko-${commit.slice(0, 12)}${preview ? `-preview-${Date.now()}` : ""}`;
const output = NodePath.join(root, "release", releaseId);
NodeFS.mkdirSync(NodePath.join(root, "release"), { recursive: true });
NodeFS.mkdirSync(output, { recursive: false });
run(
  "corepack",
  ["pnpm", "--filter", "@t3tools/web", "exec", "vp", "build", "--logLevel", "warn"],
  root,
  false,
  env,
);
run(
  "corepack",
  ["pnpm", "--filter", "t3", "exec", "node", "scripts/cli.ts", "build"],
  root,
  false,
  env,
);
// As in the upstream publisher, exclude private workspace devDependencies and
// resolve catalog entries. Stage a separate manifest instead of editing source.
const serverPackage = JSON.parse(
  NodeFS.readFileSync(NodePath.join(root, "apps/server/package.json"), "utf8"),
);
const require = NodeModule.createRequire(NodePath.join(root, "apps/server/package.json"));
const workspace = require("yaml").parse(
  NodeFS.readFileSync(NodePath.join(root, "pnpm-workspace.yaml"), "utf8"),
);
const { devDependencies: _dev, scripts: _scripts, ...runtimePackage } = serverPackage;
runtimePackage.dependencies = resolveCatalogDependencies(
  serverPackage.dependencies,
  workspace.catalog ?? {},
  "apps/server",
);
runtimePackage.overrides = resolveCatalogDependencies(
  workspace.overrides ?? {},
  workspace.catalog ?? {},
  "apps/server",
);
runtimePackage.repository = {
  ...serverPackage.repository,
  url: "https://github.com/nobody0/t3code",
};
const staging = NodePath.join(output, "package");
NodeFS.mkdirSync(staging);
NodeFS.cpSync(NodePath.join(root, "apps/server/dist"), NodePath.join(staging, "dist"), {
  recursive: true,
});
// The launch helper is dependency-free and travels with the verified runtime.
NodeFS.copyFileSync(
  NodePath.join(root, "scripts/ko-session.mjs"),
  NodePath.join(staging, "dist/ko-session.mjs"),
);
// npm does not apply pnpm patches. Preserve patched external JS wrappers next to
// the bundle; platform-specific native siblings still install on the target.
const externals = selectCliRuntimeExternalDependencies(serverPackage.dependencies);
for (const spec of Object.keys(workspace.patchedDependencies ?? {})) {
  const name = spec.slice(0, spec.lastIndexOf("@"));
  if (!(name in externals)) continue;
  const source = NodeFS.realpathSync(NodePath.join(root, "apps/server/node_modules", name));
  const target = NodePath.join(staging, "dist/node_modules", name);
  NodeFS.cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (file) => !NodePath.relative(source, file).split(NodePath.sep).includes("node_modules"),
  });
}
NodeFS.cpSync(NodePath.join(root, "LICENSE"), NodePath.join(staging, "LICENSE"));
NodeFS.writeFileSync(
  NodePath.join(staging, "package.json"),
  JSON.stringify(runtimePackage, null, 2) + "\n",
);
run("tar", ["-czf", "t3-code.tgz", "package"], output);
const archive = NodeFS.readFileSync(NodePath.join(output, "t3-code.tgz"));
if (
  !preview &&
  (run("git", ["rev-parse", "HEAD"], root, true) !== commit ||
    run("git", ["status", "--porcelain", "--untracked-files=normal"], root, true))
) {
  throw new Error("Source changed during the build; no release manifest was issued.");
}
NodeFS.writeFileSync(
  NodePath.join(output, "release.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      repository: "https://github.com/nobody0/t3code",
      commit,
      version,
      releaseId,
      preview,
      dirty,
      node: process.version,
      lockfileSha256: NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(NodePath.join(root, "pnpm-lock.yaml")))
        .digest("hex"),
      packageManager: JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"))
        .packageManager,
      artifact: "t3-code.tgz",
      sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Release prepared: ${output}`);

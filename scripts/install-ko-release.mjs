#!/usr/bin/env node
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { installRelease } from "./lib/ko-release.mjs";

if (process.argv.length < 3 || process.argv.length > 4)
  throw new Error("Usage: node scripts/install-ko-release.mjs RELEASE_DIRECTORY [RELEASES_ROOT]");
const target = installRelease(
  NodePath.resolve(process.argv[2]),
  NodePath.resolve(
    process.argv[3] ?? NodePath.join(NodeOS.homedir(), ".local/share/t3-code-ko/releases"),
  ),
);
console.log(`Installed and verified: ${target}`);
console.log("No service or live data was changed.");

#!/usr/bin/env node
import { loadConfig, manage, status } from "./lib/ko-deployment.mjs";

const [operation, configPath, releaseId, extra] = process.argv.slice(2);
if (
  !configPath ||
  extra ||
  !["status", "activate", "rollback"].includes(operation) ||
  (operation === "activate") !== Boolean(releaseId)
) {
  throw new Error(
    "Usage: node scripts/manage-ko-release.mjs status|rollback CONFIG.json | activate CONFIG.json RELEASE_ID",
  );
}
const config = loadConfig(configPath);
if (operation === "status") console.log(JSON.stringify(status(config), null, 2));
else {
  await manage(config, operation, releaseId);
  console.log(`${operation} completed for ${config.service}`);
}

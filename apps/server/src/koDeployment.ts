import * as Context from "effect/Context";

import packageJson from "../package.json" with { type: "json" };

// Artifact ownership survives SSH sessions without the service's environment.
export const isKoBuild = packageJson.repository.url === "https://github.com/nobody0/t3code";
export const KoManagedDeployment = Context.Reference<boolean>("t3/KoManagedDeployment", {
  defaultValue: () => isKoBuild,
});
export const KO_DEPLOYMENT_MESSAGE =
  "This T3 build is managed by the KO fork. Use scripts/manage-ko-release.mjs and docs/operations/ko-fork.md in nobody0/t3code; upstream service and update commands would replace the fork deployment.";

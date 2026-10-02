# Managed fork operations

Release preparation, deployment, recovery and the KO session helper are maintained in [nobody0/t3-code-ops](https://github.com/nobody0/t3-code-ops). Follow that repository's runbook for agent-approved updates.

This fork retains the service/update ownership guards. Upstream authentication is unchanged. The external packager preserves the installed `dist/ko-session.mjs` entrypoint for compatibility; new agents use the deployment's `tools/scripts/ko-session.mjs`.

Never run upstream update/service replacement commands against a managed fleet installation. Preserve the existing T3 home and identities. Binary rollback cannot undo database migrations.

# @astra-dsh/host-control

Private host-side control plane for the Astra-DSH bridge.

- Socket: `$DSH_HOME/astra-dsh/host-control.sock` (0600, Unix only)
- Status: `$DSH_HOME/astra-dsh/host-control.json`
- Protocol: newline-delimited JSON request/response, `protocol: 1`

Methods: `health`, `create`, `prompt`, `cancel`, `status`, `workspaces`, `follow`.

This package is deliberately separate from `@astra-dsh/workspace-attach` so the
attach/catalog path can be disabled independently. It uses only
`ctx.sessionController` and `ctx.workspaceRegistry`; it does not read or patch
DSH internal files.

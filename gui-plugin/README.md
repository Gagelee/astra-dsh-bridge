# @astra-dsh/workspace-attach

Host-only DSH GUI plugin that publishes bridge-created ACP sessions into the
client session catalog and groups them under their project Workspace.

- The bridge writes one JSON request per identity under
  `$DSH_HOME/astra-dsh/attach/<taskId>~<sessionId>~<generation>~<workspaceHash>.json`.
  Legacy `<taskId>.json` requests (no schema) are migrated to `existing`.
- The plugin polls the queue and, inside the GUI process, **confirms the session
  exists first** via the read-only `ctx.sessionController.list()` (never resumes
  or creates an Agent), then publishes it with
  `ctx.emit('api-session/added', summary)` — the same event the host emits for
  internally created sessions — so it appears without a GUI restart.
- It then groups the session with
  `workspaceRegistry.resolveByPath/create` + `workspace.attachSession`, honouring
  the request's policy:
  - `existing` (default): reuse only an already-registered workspace for the
    same canonical path; otherwise report `unregistered` and skip.
  - `create`: create the workspace if missing (title optional, default = the
    directory name).
  - `off`: no publish, no grouping, no side effects (reports `off`).
- On success (or a terminal `unregistered`/`off`/`failed`) it writes a durable
  ACK at `<…>.ack.json`, then deletes the request. The ACK only proves the host
  published the list update; it does not claim the client rendered it.
- Requests use immutable per-identity filenames, so an in-flight process can
  never delete or overwrite a newer request/ACK written by the bridge in the
  meantime.
- Transient conditions (session not yet visible, registry not ready) retry with
  backoff and survive a plugin restart; malformed files are quarantined and one
  bad file never crashes the pump. One shared `sessionController.list()` is made
  per pump. Title/blank changes are followed up for a bounded window after a
  publish. The plugin writes a heartbeat at `$DSH_HOME/astra-dsh/heartbeat.json`
  for `astra_status`.
- The plugin does not activate or write the session; ACP remains the owner.

## Install

Install in the running Harness profile with the Plugin Manager's
`install_bundle` action and this directory as the target. The bundle is fully
self-contained: `index.js` imports only `./protocol.js` (which depends only on
node builtins) — no files outside this directory. It can be installed as a link
or a copied bundle.

```
plugin_manager install_bundle /path/to/astra-dsh-bridge/gui-plugin
```

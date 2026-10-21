# @astra-dsh/workspace-attach

Host-only DSH GUI plugin that attaches bridge-created ACP sessions to their
project Workspace.

- Bridge writes one JSON request per session under `$DSH_HOME/astra-dsh/attach/`.
- Plugin polls every 2s, resolves or creates the Workspace by path, then calls
  `workspace.attachSession(sessionId)` in the GUI process.
- Success deletes the request; failures retry up to 10 times and then move the
  request to `*.failed-*`.
- The plugin does not activate or write the session; ACP remains the owner.

Install in the running Harness profile with the Plugin Manager's
`install_bundle` action and this directory as the target. The current desktop
profile was installed with:

```
plugin_manager install_bundle /path/to/astra-dsh-bridge/gui-plugin
```

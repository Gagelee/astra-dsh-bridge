# Security notes

- Never commit `~/.dsh`, `.astra-dsh/`, `.credentials.yaml`, or Codex auth files.
  The repository `.gitignore` covers the bridge state directory, but check
  `git status` before publishing.
- The bridge can be configured to grant Codex's MCP sandbox write access to
  `~/.dsh` so DSH GUI sessions can be grouped. That is a deliberate tradeoff;
  narrow `sandbox_workspace_write.writable_roots` if you do not need it.
- `verifyCommands` are executed by the bridge in the shared workspace. Treat
  them as trusted input and do not accept arbitrary commands from untrusted
  users.

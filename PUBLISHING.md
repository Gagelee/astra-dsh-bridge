# Publishing

This repository is self-contained: Node 20+ only, no build step, no runtime
dependencies.

## Before publishing

```bash
node --test test/*.test.mjs
git status --short
```

Do not commit `.dsh`, `.astra-dsh`, credentials, auth files, or local logs.
They are ignored by `.gitignore`; verify with `git status`.

## Create the GitHub repository

```bash
git init -b main
git add .
git commit -m "feat: Astra-DSH bridge"
gh repo create astra-dsh-bridge --public --source=. --remote=origin --push
```

Use `--private` instead of `--public` if the repository should not be public.

## GUI grouping plugin

`gui-plugin/` is a local DSH bundle. After cloning on a new machine, install it
from the Harness Plugin Manager:

```text
plugin_manager install_bundle /path/to/astra-dsh-bridge/gui-plugin
```

Without it, ACP sessions still run; they simply remain under Ungrouped in the
DSH GUI.

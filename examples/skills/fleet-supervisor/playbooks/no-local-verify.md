---
id: no-local-verify
cooldown_min: 30
max_attempts: 2
ask: ""
---
Stop. Don't verify locally: process {pid} in your worktree looks like a local build or verify ({age} min). If it is yours, stop it and use BuildBot3: bb-quick while the PR is half-built. The merge gate is {mergeGate} on the exact head. If it is not a local build or verify, say so in one line and carry on.

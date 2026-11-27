# AI-Zen CLI Documentation

`@ai-zen/cli` is the terminal client for an AI-Zen host. The pages follow the order of use: connect, understand the interface, learn the commands, change the configuration.

| Page | Contents |
|---|---|
| [Getting started](getting-started.md) | Install, the connect screen, the two run modes, the first message, exiting and exit codes |
| [Interface](interface.md) | Every area from the bottom up, all key bindings, behaviour while busy, three overlays, sub-agent columns |
| [Commands](commands.md) | 28 commands grouped by purpose; the two scopes; two command attributes |
| [Configuration](configuration.md) | The configuration centre, three-level model resolution, thinking levels, the two thresholds, MCP, language |
| [Pipeline and hooks](pipeline.md) | The output contract and exit codes of a one-shot call; the shell hook |
| [Troubleshooting](troubleshooting.md) | Cannot connect, commands refused, capabilities not taking effect, keys ignored, logs, upgrades |

The client does not call models and does not store sessions: sessions, history and model configuration all live on the host side. That part is documented with `@ai-zen/agents-host`.

# Configuration

Configuration lives in two places, and the boundary is who needs to read it:

| File | Content | Written by |
|---|---|---|
| `<data root>/config.json` | Endpoints, models, image models, agent definitions, sub-agents, MCP server references | The client, through the host's procedures |
| `<data root>/cli/preferences.json` | Interface language | The CLI alone |

The interface language does not go into `config.json`: that file's shape is shared across clients, so putting a CLI preference in it gives the desktop app something it cannot interpret and may drop on write-back.

## The configuration centre

`/config` opens it, and all four kinds of settings are there:

| Group | Editable |
|---|---|
| Endpoints | Name, base URL, API key, description |
| Models | Endpoint, model name sent to the endpoint, reasoning preset, handoff threshold, guard threshold, vision support |
| Image models | Endpoint, model name, default size, default quality |
| Agent definitions | Name, description, system prompt, bound model, the four permission dimensions; sub-agents additionally have a function description and a parameter schema |
| MCP servers | Transport, command and arguments, environment variables, headers, enabled state |

Long text fields (system prompt, parameter schema) open an external editor on `Enter`. Validation happens before saving: the name cannot be empty, the base URL must start with `http://` or `https://`, the API key cannot be empty, and the parameter schema must be a JSON object.

## Three-level model resolution

Which model a session uses is resolved in three levels, first hit wins:

1. The session row's `modelId` ("this session" in `/model`)
2. The agent definition's `modelId` ("agent definition")
3. `defaultModel` in `config.json` ("global")

When all three are empty it fails, and the error names the definition that has no bound model. It does not quietly fall back to a factory model — that would show A in the interface while the request and the bill went to B.

Parameters follow the level the model came from: when the session overrides the model, the `modelParams` on the agent definition are not merged in. Parameters meant for the old model would be rejected by the endpoint.

## Thinking levels

The levels available to `/think` are not hard-coded; they are read from the endpoint's preset table `<data root>/reasoning-presets.json`. Whatever levels the table has are the ones on offer:

- Turning thinking off requires an `off` level in the table. A model that always thinks and has no disabling parameter simply has no off level
- Choosing "follow model default" clears this layer and falls back to the model definition's `defaultParams`
- Each level corresponds to a set of request parameter patches. Provider differences (`reasoning_effort` versus `thinking`) stay inside the table; the client only writes the chosen level into the configuration

No level arithmetic happens at runtime: what is written into the configuration is the expanded parameters, and a request only does one shallow merge.

## Handoff thresholds

Both thresholds can be written on the model definition or overridden per session (the configuration centre edits the former; session overrides are written by the handoff-related entry points):

| Threshold | Meaning |
|---|---|
| Handoff threshold (`handoff`) | Soft line. Crossed, the agent hands off when it is idle |
| Guard threshold (`guard`) | Hard line. Compared before every request; crossing it rejects the request |

The factory values are 40% and 80% of the window. Both are absolute numbers.

## API keys

`/key` sets one endpoint's key in place. The plaintext is stored in `config.json` and the file permissions are the user's responsibility. This key is not a credential in the sense of connecting to a host — that one lives on the host side, see `/upgrade` and the host documentation.

## MCP servers

`/mcp` adds, removes, edits, enables and disables servers. Which file is written depends on the layer the server came from:

| Layer | File | Editable from here |
|---|---|---|
| Project host directory | `<project>/.ai-zen/mcp.json` | Yes |
| User level | `<data root>/mcp.json` | Yes |
| Project root, project shared directory, home shared directory | the respective `mcp.json` | Read-only: those files belong to someone else |

Renaming, changing the transport and disabling all happen here. Disabling writes `disabled` on that entry rather than removing it — removing it would let a farther definition of the same name come back to life, which is not what you asked for.

No restart is needed after editing: use `/reload`, or wait for the host's `autoRefreshTools` refresh.

## Language

`/lang` switches the interface language and writes `<data root>/cli/preferences.json`. The host's language is a separate setting: it lives in `language` in `config.json` and affects text the host produces (notices, questions, error messages). The client syncs its own language to the host once it connects, so the two normally agree.

## Default agent

`/agent` sets which agent definition new sessions default to. It does not change the definition this session uses, and it does not change the model: the model bound in a definition is the second resolution level, which is a different thing from this session's model override.

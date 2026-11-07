# mcp/ — the MCP server for driving a live bot

A self-contained [MCP](https://modelcontextprotocol.io) stdio server that lets an
AI operator (Claude Code, or any MCP client) inspect and drive running bots over
the loopback TCP bridge. It is a thin proxy: the in-game container is the source
of truth for the command set, so new bridge commands work through `mc_send`
without touching this server.

## Run

No install step — [uv](https://docs.astral.sh/uv/) resolves the inline
dependencies (`fastmcp`, `httpx`, `mcp`) on first run (about 25 s the first time,
cached after):

```sh
uv run mcp/server.py
```

Use uv. Without it, install into a virtual environment — Ubuntu 24.04 and other
current distros refuse `pip install` into the system Python (PEP 668):

```sh
python3 -m venv .venv
.venv/bin/pip install "fastmcp>=2" "httpx>=0.27" "mcp>=1.0"
.venv/bin/python mcp/server.py
```

## Wire into Claude Code

Copy `.mcp.json.example` at the repo root to `.mcp.json` (gitignored) and adjust
paths/ports if needed. Then `claude` started in the repo root picks it up and
exposes the `mc_*` tools (the path in that file is relative to the repo root).

## Wire into any other MCP client / LLM agent

It's a standard stdio MCP server — any client that speaks MCP (Cursor, Windsurf,
Claude Desktop, a LangChain/OpenAI agent via an MCP adapter, your own loop) wires
it with the usual shape:

```json
{
  "mcpServers": {
    "mc": {
      "command": "uv",
      "args": ["run", "/abs/path/to/repo/mcp/server.py"],
      "env": { "MC_BRIDGE_PORT": "55544" }
    }
  }
}
```

A client started from a desktop menu often lacks `~/.local/bin` (where uv
installs) on its PATH; give `command` the absolute path to `uv` then.

The driving pattern an agent should follow:

1. `mc_ping` → is a bot listening at all. With no bridge, the per-bot tools
   return an error result (`isError: true`) that names the host:port tried.
2. Read the **`mc://api` resource** — the LIVE command manifest straight from the
   in-game container (names, params, help). Don't hardcode a command list; the
   set grows with every ext.js plugin and this manifest is the truth.
3. `mc_get_state` for the situational snapshot (pos/health/phase/mission), then
   `mc_send(type, args)` for everything else — missions, scans, GUI clicks,
   `eval`/`jeval`. One generic tool, the whole surface.
4. Multi-bot: pass `target="<bot-name>"` (resolved via `mc://bots`), and use
   `mc_fleet_*` only if the coordinator hub is running.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `MC_BRIDGE_HOST` | `auto` | Bridge host; `auto` probes loopback, then the WSL gateway. `./gerda ctl` reads it too. On one machine, set `127.0.0.1` |
| `MC_BRIDGE_PORT` | `55544` | Default single-bot bridge port |
| `MC_BRIDGE_TIMEOUT` | `5` | Per-command timeout, seconds |
| `MC_FLEET_HUB` | `http://127.0.0.1:8849` | Coordinator hub (multi-bot; optional) |
| `MC_BOTS_REGISTRY` | repo-root `mc-bots.json` | Fleet registry for `target=` routing |

## Surface

Per-bot tools (`target=` picks a bot from the registry; omit for the default
bridge): `mc_ping`, `mc_get_state`, and the generic `mc_send(type, args)` —
the single path for all game commands. Fleet tools (`mc_fleet_*`) talk to the
coordinator hub and only matter for multi-bot setups. Read-only resources:
`mc://state`, `mc://logs`, `mc://api` (live command manifest), `mc://bots`.

`bridge_client.py` here is the canonical TCP client; the CLI scripts under
`scripts/` import it directly (each adds this `mcp/` dir to `sys.path`), so
`scripts/ops/bridge_ctl.py` remains the no-MCP fallback with the same capabilities.

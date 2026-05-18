# pi-services

Pi extension: per-project service definitions with background execution and live log access for the agent.

Declare named commands (`backend -> uv run -m api.main`) per project. The extension spawns them in the background, captures their logs, and exposes a `service_logs` tool the agent uses to debug live.

## Install

Add to your `~/.pi/agent/settings.json` packages list:

```json
{ "packages": ["pi-services"] }
```

Or install locally and point Pi at it.

## Per-project config

The extension is global. Service definitions are read from `<cwd>/.pi/services.json` at session start, so different projects get different services.

```json
{
  "services": {
    "backend": {
      "kind": "server",
      "cmd": "uv run -m api.main",
      "cwd": ".",
      "env": { "PORT": "8000" },
      "autoStart": true,
      "readyPattern": "Uvicorn running on"
    },
    "migrate": {
      "kind": "task",
      "cmd": "uv run alembic upgrade head"
    }
  }
}
```

Schema:

| field          | type                    | required | default | notes                                         |
| -------------- | ----------------------- | -------- | ------- | --------------------------------------------- |
| `kind`         | `"server" \| "task"`    | yes      | —       | server = long-running, task = one-shot        |
| `cmd`          | string                  | yes      | —       | shell command, runs via `sh -c`               |
| `cwd`          | string                  | no       | `"."`   | relative to project root                      |
| `env`          | `Record<string,string>` | no       | `{}`    | merged onto `process.env`                     |
| `autoStart`    | boolean                 | no       | `false` | only honored for `kind:"server"`              |
| `readyPattern` | regex string            | no       | —       | server is "ready" once log matches this regex |

Invalid entries are dropped with a warning surfaced via `ctx.ui.notify`. Bad regex is ignored. The agent never crashes on config errors.

## Slash commands

A single `/services` command with subcommands. Colon-namespaced names (e.g. `/service:start`) are not used because pi reserves `:` for command-collision disambiguation suffixes.

- `/services` (or `/services list`) — list declared services and live state
- `/services start <name>` — start a declared service
- `/services stop <name>` — stop a running service
- `/services restart <name>` — stop then start
- `/services logs <name> [tail]` — show last N log lines

## Agent tool

`service_logs(service, tail?, grep?, since?, errorsOnly?)` — the agent reads live logs by name. Use this instead of re-running long commands.

## Storage layout

```
<project>/.pi/services.json           # config (you write this)
<project>/.pi/services/state.json     # live PID/status (written by extension)
<project>/.pi/services/logs/<name>.log # truncated on each start
```

State is reconciled at session start: dead PIDs are dropped. Services spawned by the current runtime are stopped at `session_shutdown`.

## Non-goals

- No auto-restart on crash.
- No file-watch / hot-reload.
- No health probes.
- No multi-host / remote.
- No log rotation (truncate-on-start by design).

## Dev

```sh
pnpm install
pnpm test
node scripts/verify-package-files.mjs
```

No build step — TypeScript runs via `node --experimental-strip-types`.

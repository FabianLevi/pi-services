# pi-services

Pi extension: per-project named services with background execution and live log access for the agent.

Declare commands (`backend -> uv run -m api.main`) in `<cwd>/.pi/services.json`. The extension spawns them, captures logs, and exposes a `service_logs` tool the agent uses to debug live.

## Install

```json
// ~/.pi/agent/settings.json
{ "packages": ["pi-services"] }
```

## Config

`<cwd>/.pi/services.json`:

```json
{
  "services": {
    "backend": {
      "kind": "server",
      "cmd": "uv run -m api.main",
      "env": { "PORT": "8000" },
      "autoStart": true,
      "readyPattern": "Uvicorn running on"
    },
    "migrate": { "kind": "task", "cmd": "uv run alembic upgrade head" }
  }
}
```

| field          | type                    | default | notes                                  |
| -------------- | ----------------------- | ------- | -------------------------------------- |
| `kind`         | `"server" \| "task"`    | —       | server = long-running, task = one-shot |
| `cmd`          | string                  | —       | runs via `sh -c`                       |
| `cwd`          | string                  | `"."`   | relative to project root               |
| `env`          | `Record<string,string>` | `{}`    | merged onto `process.env`              |
| `autoStart`    | boolean                 | `false` | `kind:"server"` only                   |
| `readyPattern` | regex string            | —       | server is ready once log matches       |

Invalid entries are dropped with a warning.

## Attached runner

Run a service in your own terminal while Pi tracks its state and live logs:

```sh
pi-services run frontend -- pnpm dev
```

This keeps stdout/stderr visible in that terminal and tees both streams to `.pi/services/logs/frontend.log`, while `.pi/services/state.json` records the child PID/status. Press `Ctrl+C` in that terminal to stop the command; Pi will mark the service exited.

A common workflow is to wrap your normal dev script:

```json
{ "scripts": { "dev": "pi-services run frontend -- vite" } }
```

Then `pnpm dev` is automatically visible to Pi as the `frontend` service.

## Slash commands

- `/services ui` — interactive overlay. Keys: `↑↓` select, `enter`/`t` tail, `s` start, `x` stop, `r` restart, `esc`/`q` close. In tail: `↑↓` scroll, `g` top, `G` follow, `x` stop, `r` restart.
- `/services` — list declared services + live state
- `/services start|stop|restart <name>`
- `/services logs <name> [tail]`
- `/services run <name>` — print `pi-services run <name> -- <cmd>` for use in another terminal

For attached services, `/services stop <name>` does not kill the external terminal process; stop it where you started it.

## Agent tool

`service_logs(service, tail?, grep?, since?, errorsOnly?)` — read live logs by name instead of re-running commands.

## Status widget

When services are running, a wrap-aware row renders below the editor with `● name` chips colored by state. Stopped/exited services don't appear — use `/services` for the full table.

## Storage

```
<project>/.pi/services.json            # config
<project>/.pi/services/state.json      # live PID/status
<project>/.pi/services/logs/<name>.log # truncated on each start/run
```

State is reconciled at session start (dead PIDs dropped). Services spawned by the current runtime are stopped on `session_shutdown` and on terminal teardown (SIGHUP / SIGINT / SIGTERM / Ctrl+Z / normal exit) so they don't outlive pi.

## Dev

```sh
pnpm install
pnpm test
```

No build step — TypeScript runs via `node --experimental-strip-types`.

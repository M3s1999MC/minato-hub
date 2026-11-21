# Minato Hub

Lightweight, multi-instance hosting manager and control panel built primarily with native Node.js modules and PostgreSQL persistence. Designed to keep base memory usage low while managing multiple independent bots or services from a single dashboard.

## Key Features

- **Low Memory Footprint:** Relies on native Node.js modules (`http`, `fs`, `path`, `child_process`, `os`, `crypto`) without heavy web frameworks, keeping base overhead lean.
- **Multi-Instance Management:** Create, configure, start, stop, restart, update, and remove multiple independent instances (such as bots, workers, or shared projects).
- **Isolated Workspaces & Environment:** Each instance runs in its own isolated working directory (`git clone` / `git pull`) with its own environment variables and child heap memory limit (`--max-old-space-size`).
- **PostgreSQL Persistence:** Stores instance definitions, environment variables, and runtime flags in PostgreSQL so configurations survive container restarts and ephemeral storage resets.
- **Controlled Watchdog & Ring Buffer Logs:** Automatically restarts crashed instances with controlled retry/backoff logic and keeps a fixed-size circular log buffer per instance to prevent unbounded log memory growth.
- **Protected Web Dashboard & Health Endpoint:** Includes a minimal dark UI for managing instances and viewing live logs, secured via `MINATO_SECRET`, alongside a lightweight `GET /health` endpoint.
- **Multi-Node Ready:** Designed with node routing support so instances can be delegated to remote worker nodes in the future.

## Environment Variables

Configure these environment variables before starting Minato Hub:

| Variable | Required | Description |
| :--- | :---: | :--- |
| `PORT` | No | HTTP port for the panel and API (defaults to `3000` or platform-provided `PORT`). |
| `MINATO_SECRET` | Yes | Secret token required to authenticate API requests and access the control panel. |
| `DATABASE_URL` | Yes | PostgreSQL connection string used to persist instances and configurations. |

## Quick Start

1. **Clone the repository and install dependencies:**
   ```bash
   git clone [https://github.com/your-user/minato-hub.git](https://github.com/your-user/minato-hub.git)
   cd minato-hub
   npm install

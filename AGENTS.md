# AGENTS.md

Before making implementation changes, read and follow the repo-wide
[`CODING_STANDARDS.md`](./CODING_STANDARDS.md).

## First-time setup

Run once after cloning to activate the committed git hooks:

```bash
git config core.hooksPath .githooks
```

The pre-commit hook keeps `model_prices_backup.json` in sync with the
upstream litellm JSON on every commit. It warns and skips silently if
the network is unavailable — it never blocks a commit.

## MCP integration invariants

`mcp_server_ids` (in `AgentDraft`) is the **sole source of truth** for which
MCP integrations are attached to an agent.

- `createInputFromDraft` must derive `mcp_servers` and `mcp_toolset` tool
  entries exclusively from `mcp_server_ids`. Never read `mcp_toolset` entries
  back out of `draft.tools` to build the output — those may be stale.
- Strip all `mcp_toolset` entries from `draft.tools` before building
  `allTools`, then append fresh toolsets from `resolvedMcpServers`.
- Only emit a toolset for an ID that resolved to a known `INTEGRATIONS` entry.
  An ID with no matching integration produces no toolset and no server URL.

On the backend (`runtime_provision.rs`), `integration_mcp_toolsets` must
cross-check each toolset's `mcp_server_name` against the resolved `mcp_servers`
list. Any toolset whose server name is absent from `mcp_servers` is dropped.

## Cursor Cloud specific instructions

### Quick reference

| Task | Command |
|------|---------|
| Run full stack (preferred) | `docker compose up` or `./setup-local.sh opencode` |
| Run from source | See **Source workflow** below |
| UI dev server | `cd src/ui && LITELLM_DEV_API_BASE=http://localhost:4000 npm run dev` |
| Rust tests | `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/lap_test cargo test --locked` |
| Rust lint | `cargo fmt --all --check && cargo clippy --all-targets --locked -- -D warnings` |
| UI lint | `cd src/ui && npm run lint` |
| Code size check | `python3 scripts/check_code_size.py` |

Standard setup details live in [`readme.md`](./readme.md) and [`docs/contributing.md`](./docs/contributing.md).

### Docker vs source

`readme.md` recommends `docker compose up`. In Cloud Agent VMs, Docker Hub image pulls (`postgres:16-alpine`, etc.) may fail with network errors; use the **source workflow** below when compose cannot pull images.

Docker daemon in this VM uses `fuse-overlayfs` storage driver. Start manually if needed: `sudo dockerd &` (socket permissions: `sudo chmod 666 /var/run/docker.sock`).

### Source workflow (no Docker images)

PostgreSQL 16 must be running locally with:

- **LAP app DB:** `postgres://lap:lap@127.0.0.1:5432/litellm_agents`
- **Test DB:** `postgres://postgres:postgres@127.0.0.1:5432/lap_test`

Build the static UI once, then serve it from the Rust binary:

```bash
cd src/ui && npm run build
export LITELLM_MASTER_KEY=sk-local
export DATABASE_URL=postgres://lap:lap@127.0.0.1:5432/litellm_agents
export LITELLM_UI_DIR=/workspace/src/ui/out
export HOST=0.0.0.0 PORT=4000
cargo run --bin lite -- serve --config deploy/render.config.yaml --host 0.0.0.0 --port 4000
```

Use `deploy/render.config.yaml` for local serve — it only requires `LITELLM_MASTER_KEY` and `DATABASE_URL` (unlike `config.yaml.example`, which references many optional `os.environ/*` vars).

Default login master key: `sk-local`. Health check: `curl http://localhost:4000/health`.

### PostgreSQL for tests

Integration tests expect `TEST_DATABASE_URL` (see `.github/workflows/rust-checks.yml`). If `postgres` user password auth fails, set it once:

```bash
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'postgres';"
```

### Rust toolchain

CI uses `rustup default stable`. The Docker image pins Rust 1.90; local `stable` (1.96+) works for `cargo build` and `cargo test`.

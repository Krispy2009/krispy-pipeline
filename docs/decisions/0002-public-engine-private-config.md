# 0002 — Public engine, private config

**Status:** Accepted, 2026-11-18

## Context

The engine is reusable and makes a good public portfolio piece. The client list, repo names and credentials are confidential.

## Decision

This repo holds only the engine: code, prompts, templates and example config. Real project YAMLs, allowlists and App IDs live in `~/.config/krispy-pipeline/`. Secrets live only in the OS keyring. gitleaks runs on every commit.

## Consequences

- Security must not depend on the code being secret.
- Fixtures and examples use invented names (`acme/widgets`).
- A committed project YAML would leak the client list even with no secrets in it. `.gitignore` blocks `config/*.yaml` except `*.example.yaml`.

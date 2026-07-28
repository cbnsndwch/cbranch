# ADR 0004: Restrict local embeddings to Ollama's loopback API

## Status

Accepted — 2026-07-27

## Context

The inference plan calls for a local embedding option. OpenCode remains an
agent-harness integration and therefore does not meet Workspace Intelligence's
no-tool/no-repository boundary (ADR 0003). Claude Code and Codex have separate,
constrained one-shot generation admissions in that ADR, but neither provides
embeddings.

This host has a discovered `ollama` executable and locally installed embedding
models. Ollama exposes a dedicated embedding API, so embeddings do not require
starting a coding agent or spawning a general CLI process.

## Decision

`local-embeddings` profiles may designate a discovered Ollama executable and a
manual embedding model ID. The host does not execute that executable for a
Workspace Intelligence request. Instead, it issues a bounded request only to
the fixed loopback endpoint `http://127.0.0.1:11434/api/embed`.

The adapter:

1. has no repository root, cwd, shell, or tool interface;
2. sends only cbranch-selected bounded graph chunks or a user query;
3. cannot use a user-configured remote endpoint, credential, redirect, or
   provider tool declaration;
4. validates finite, dimension-consistent vectors before indexing; and
5. returns lexical graph search if the local service/model is unavailable.

This decision does not authorize local generation beyond the constrained Claude
Code and Codex adapters in ADR 0003. OpenCode remains configuration/discovery-
only until a separate non-agent one-shot compatibility spike proves the ADR 0003
conditions.

## Consequences

- A user can choose an enabled local Ollama embedding profile as the independent
  workspace default or an explicit semantic-search override.
- Semantic index cache keys continue to include profile/model and selected-chunk
  digests, so changing a local model rebuilds vectors without touching the
  deterministic run.
- The fixed loopback port is an implementation boundary, not a claim that every
  local provider is safe. Any alternate daemon, port, socket, or subprocess
  requires another ADR and boundary tests.

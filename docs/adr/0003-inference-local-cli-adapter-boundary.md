# ADR 0003: Do not use agent-harness adapters for Workspace Intelligence

## Status

Accepted — 2026-07-27

## Context

Milestone 6 needs optional enrichment through local Claude Code, Codex, and
OpenCode profiles, while preserving the deterministic analyzer boundary:

- no repository working directory;
- no autonomous file reads;
- no shell or tool use;
- cbranch-selected evidence only;
- bounded, cancellable process execution in a cbranch-managed temporary
  directory.

TanStack AI provides current Codex, Claude Code, and OpenCode adapters as
agent-harness integrations. Their documented purpose includes running an agent
loop and handling tool activity in a subprocess. That is a sound design for an
interactive coding assistant, but it is not a sound implementation of the
restricted enrichment-provider contract above.

## Decision

`packages/inference` stays provider-neutral. Its
`InferenceStructuredOutputRunner` is the only integration seam used by
normalization, validation, and the exactly-one repair policy.

The host MUST NOT wire a TanStack AI agent-harness adapter directly to a local
Workspace Intelligence profile. Doing so would grant a model a general agent
runtime and would make the declared no-tool/no-repository boundary dependent on
provider behavior rather than cbranch policy.

The installed Claude Code 2.1.220 CLI exposes a narrower command surface that
can be constrained without using its agent-harness adapter. Its host-only
adapter uses non-interactive print/JSON-schema output, an empty explicit tool
set, one maximum turn, safe/bare mode, disabled slash commands and Chrome
integration, no session persistence, and an empty strict MCP configuration.
cbranch supplies only selected graph evidence, runs
the executable in a new empty temporary directory, uses a reduced environment
with a named credential mapped to `ANTHROPIC_API_KEY`, and disables automatic
updates/nonessential traffic. It applies a 30-second default timeout, a bounded
  combined-output capture, and process-tree termination on cancellation. The
adapter never exposes a repository path, cbranch working directory, user config,
MCP server, shell, or tool declaration.

Claude Code necessarily owns its connection to Anthropic. The reduced child
environment does not supply an endpoint override and the empty home directory
contains no user configuration, but cbranch cannot portably impose a kernel
egress allowlist around a third-party CLI. This is the explicit endpoint-policy
exception: the adapter accepts only the CLI's built-in provider path and tests
the reduced environment, no-tool arguments, temporary cwd, output cap, timeout,
and cancellation boundary. Deployments requiring a host-enforced network
allowlist must keep Claude Code profiles disabled or enforce that policy outside
cbranch.

Codex is additionally admitted through a separate constrained boundary. The installed Codex
0.145.0 CLI provides `codex exec`, `--output-schema`, an ephemeral mode, a
read-only sandbox, a `never` approval policy, and user-config/rules opt-outs.
Its host-only adapter uses those controls with a disabled web-search setting,
an empty cbranch-managed temporary working root, and `--skip-git-repo-check`
because that root intentionally is not a repository. `read-only` plus `never`
means command attempts fail rather than receiving approval. The temporary root
and ignored configuration prevent repository context, user/project MCP servers,
rules, skills, and session state from entering the run. The adapter passes only
selected evidence, writes the cbranch-owned output schema into that temporary
root, supplies the named credential solely as `CODEX_API_KEY`, and applies the
same output cap, timeout, cancellation, and process-tree termination boundary
as Claude Code.

Codex, like Claude Code, owns its built-in provider connection. The adapter
does not enable command-network access, disables the separate web-search tool,
and cannot portably impose a kernel egress allowlist around a third-party CLI.
This is the same explicit endpoint-policy exception: deployments that need a
host-enforced network allowlist must keep Codex profiles disabled or enforce it
outside cbranch.

OpenCode 1.17.20 provides per-agent permissions that deny every tool. Its
host-only adapter creates an `opencode.json` in the cbranch-owned temporary
root which denies all global and selected-agent permissions, selects only that
agent, and runs `opencode --pure run` from the same empty root. `--pure` omits
external plugins; isolated `HOME` and XDG configuration/data/cache directories
exclude user configuration and erase session state when the request completes.
The CLI receives only selected evidence and must return JSON, which passes
through the shared one-repair normalizer. The adapter exposes no repository
path, source file, shell, filesystem tool, MCP server, or agent-task tool.

OpenCode owns model-provider connections and the host cannot portably impose a
kernel egress allowlist around that third-party CLI. This is the same explicit
endpoint-policy exception as the other local CLIs: deployments requiring a
host-enforced network allowlist must keep OpenCode profiles disabled or enforce
that policy outside cbranch.

Local profile discovery/configuration is permitted now because it is limited to
resolving known executables and their `--version` output from the system
temporary directory. It does not start an agent session.

Before admitting another local CLI provider, its adapter must demonstrate a
non-agent, one-shot structured-output interface that cbranch can run with:

1. an empty, cbranch-owned temporary working directory;
2. no exposed repository paths or file descriptors;
3. a reduced allowlisted environment;
4. tool/shell and filesystem-write features explicitly disabled;
5. a profile-authorized endpoint-only network policy where the host can enforce
   it, or an explicit documented exception with compensating boundary tests; and
6. timeout, output cap, process-tree cancellation, and bounded concurrency.

Remote OpenAI-compatible generation profiles use TanStack AI's structured-output
API. Remote embedding profiles use the compatible `POST /embeddings` endpoint;
the current TanStack AI package does not expose an embedding adapter. Both paths
validate the fixed endpoint, resolve a named secret reference without returning
it to the browser, send only bounded cbranch-selected graph evidence, use an
endpoint-restricted fetch with redirects disabled and a request timeout, and
configure no tools. That is distinct from the local agent-harness adapters.

## Consequences

- The foundation can safely ship profile discovery/settings and normalized
  output validation, the restricted remote structured-output path, and narrowly
  constrained Claude Code, Codex, and OpenCode one-shot adapters. Local Ollama
  embeddings
  are a separate fixed-loopback non-agent exception in ADR 0004.
- OpenCode's permission boundary is covered by an explicit compatibility spike
  and process-boundary tests, rather than a convenience agent-harness import.
- Workspace Intelligence remains deterministic and usable with all profiles
  disabled.

## Evidence

[TanStack AI's Codex adapter](https://tanstack.com/ai/latest/docs/adapters/codex)
documents a server-only harness that spawns a subprocess and owns an agent loop
with tool activity. [OpenAI's Codex safety documentation](https://openai.com/index/running-codex-safely/)
likewise treats the CLI as an agent capable of reading, writing, and executing
commands within a sandbox. Those documented semantics conflict with this
feature's narrower provider contract.

[OpenCode's permissions documentation](https://opencode.ai/docs/permissions)
documents its global and per-agent `deny` controls for filesystem, shell,
network, task, and other tools. The adapter's generated local configuration
uses those controls without importing an agent-harness integration.

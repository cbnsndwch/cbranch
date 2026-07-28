# Workspace Intelligence inference profiles

Inference profiles are reusable host-local metadata. They are optional: a new
workspace has no generation or embedding default, and deterministic Workspace
Intelligence reports work unchanged with every profile disabled.

## Configure a profile

Open **Settings → Inference**. Use **Detect local tools** to find a supported
local Claude Code, Codex, or OpenCode executable. Discovery only resolves a
known executable on the host `PATH` and runs its bounded `--version` command
from the system temporary directory. It does not open a repository, send a
prompt, or transmit source/evidence.

You can alternatively add a profile manually:

- Local Claude Code, Codex, OpenCode, and local embeddings require a
  cbranch-discovered executable path.
- An OpenAI-compatible profile requires an `http` or `https` endpoint. The
  host rejects endpoint URLs containing credentials, a query string, or a
  fragment.
- OpenAI-compatible profiles may support generation, embeddings, or both.
  Local Claude Code, Codex, and OpenCode profiles support generation only;
  local Ollama profiles support embeddings only.
- A disabled draft may remain incomplete while you discover a model or set up
  its named credential reference. Enabling requires an explicit model ID; all
  generation profiles and OpenAI-compatible embedding profiles also require a
  named credential reference. Ollama embeddings require no credential
  reference.

The supported local-embedding runtime is a discovered **Ollama** executable.
Set its installed embedding model ID (for example, a model shown by `ollama
list`) and select only **Embeddings**. Workspace Intelligence uses Ollama's
fixed local loopback embedding API; it does not launch the executable, run a
shell, or expose a repository directory. See ADR 0004.

For a saved OpenAI-compatible profile, **Discover models** issues a bounded
`GET /models` request to that profile's configured endpoint. It uses the named
credential reference but sends no workspace, graph, source, or prompt data.
The returned IDs are suggestions only: choosing one explicitly saves the manual
model-ID override. Discovery is available before a profile is enabled so an
operator can validate setup without authorizing Workspace Intelligence use.

Profiles are shared by this host. In the same Settings tab, select independent
generation and embedding defaults for the active workspace. A default can refer
only to an enabled profile with the matching capability. Disabling or removing a
profile clears only defaults that become invalid; a valid independent default is
preserved.

## Credentials

The UI has no API-key, token, password, or authorization-header field. A
profile may reference either an environment-variable name or a secret-store
entry name. For example, `OPENAI_API_KEY` is a reference name—not its value.
`config.json`, RPC responses, reports, archives, and browser state contain that
reference only.

## Current execution boundary

Configuring or detecting a provider does **not** invoke a model, make a remote
request, read workspace files, or create an enrichment artifact. Invocation is
an explicit **Run enrichment** action for a valid deterministic run.

The current execution path supports enabled OpenAI-compatible generation and
embedding profiles, enabled local Ollama embedding profiles, and enabled Claude
Code, Codex, or OpenCode generation profiles that name both a model and a
credential reference.
Remote generation passes a bounded, cbranch-selected projection of the
persisted deterministic graph to TanStack AI structured output; it never
supplies a repository path, working directory, source-reading capability, or
tool list. Claude Code runs only as a one-shot no-tool process from a new empty
temporary directory, with no MCP configuration or user session/configuration
state. Codex runs only from an empty temporary directory in its ephemeral,
read-only/no-approval mode with web search disabled and no loaded user/project
configuration or rules. OpenCode runs only from an empty temporary directory
with isolated XDG state, `--pure`, and a generated configuration that denies
every global and selected-agent tool permission. Remote embedding calls use the
compatible `POST /embeddings` endpoint with the same selected graph chunks and
no agent/tool interface. Local Ollama
embeddings use only the fixed loopback endpoint described above. Each request
fails closed on a redirect where applicable, has a 30-second per-request
timeout, and is limited to one concurrent host inference operation by default
(`CBRANCH_INTELLIGENCE_MAX_CONCURRENT_ENRICHMENTS` can raise the
positive-integer limit). Invalid generation output receives one repair attempt
before the independent attempt is marked failed.

Attempts store normalized inferred relationships, selected evidence IDs, timing,
usage, and failure summaries only. They never store raw prompts, raw provider
responses, credentials, or endpoint configuration. The deterministic report and
graph remain authoritative; inferred relationships are hidden until the user
explicitly opens them, and a completed attempt must be explicitly preferred for
presentation. Revealed relationships show their selected evidence IDs and can
be confirmed, rejected, or annotated as workspace-local curation. Those actions
retain the stable edge identity and attempt/profile/model provenance while never
rewriting either deterministic or inferred artifacts.

While an enrichment request is in progress, **Cancel enrichment** aborts the
host-owned provider request. It does not cancel a deterministic run or alter an
existing result. Once the profile and selected evidence are known, cancellation
is retained as its own immutable attempt with no inferred relationships, so it
cannot become the preferred presentation.

## Semantic search

Semantic retrieval is explicitly opt-in: select **Use semantic search**, then
press **Search semantically** beside the architecture search input. It uses the
workspace embedding default (or an explicit search-profile override), and
otherwise transparently shows lexical results with a short status message. It
also falls back to lexical results when the provider is unavailable, the run has
no graph chunks, or the inference limit is busy. Editing the query never
sends a provider request until **Search semantically** is pressed again.

For a valid run, the host indexes at most 200 bounded graph chunks. Its cache is
keyed by run, profile, model, and digest of the selected chunks. It persists a
schema-versioned manifest containing only profile/model IDs, chunk IDs/digest,
dimensions, and a binary float-vector matrix. Chunk text, prompts, provider
responses, credentials, endpoint data, and source trees are not stored in the
semantic cache or archive. The cache is rebuildable and is removed with its
deterministic run.

Local Ollama embedding profiles are supported through their fixed loopback
embedding API; ADR 0003 defines the local generation safety boundary.

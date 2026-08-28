# Workspace Intelligence: first analysis and optional AI enrichment

Workspace Intelligence has two separate stages. The first is deterministic and
read-only. The second is optional AI enrichment. Completing the first stage
does not call a model or transmit workspace source.

## Run your first analysis

1. Open an engagement and select **Intelligence**.
2. Confirm the repository members, then choose **Analyze workspace**.
3. Wait for the run to complete. A completed report shows coverage, readable
   architecture findings, and a bounded graph preview.
4. Choose **Inspect graph** to search and expand architecture records, or
   **Download full artifacts** to inspect the complete report and graph export.

The graph preview is intentionally bounded for readability. Its bounded notice
does not mean the analysis failed or that the report is incomplete; coverage
and explicit limitations appear separately in the report.

## Understand findings and coverage

Architecture findings are deterministic observations. **Needs review** means
the report found something worth inspecting, such as a verified dependency
cycle or an unresolved reference. It is not an AI warning and it does not
change a repository.

Every run records coverage and capability gaps. Treat a partial run or an
explicit unknown as a limitation of that result, not evidence that the
corresponding architecture relationship is absent.

## Set up optional AI enrichment

After a valid deterministic run, the Intelligence view says whether AI
enrichment has run. If no generation profile is available, choose **Set up AI
enrichment**. The action opens **Settings → Inference**.

1. Choose **Detect local tools** for a local Claude Code, Codex, OpenCode, or
   Ollama executable, then choose **Use**. You may instead add an
   OpenAI-compatible endpoint manually.
2. Set the provider's exact model ID.
3. For generation and remote embedding profiles, enter the name of an
   environment variable or secret-store entry that holds the credential. Enter
   a name such as `OPENAI_API_KEY`, never its value.
4. Enable and save the profile. Select it as the workspace generation or
   embedding default, or select it for the individual run.
5. Return to a valid run and choose **Run enrichment**. Review a completed
   attempt before choosing **Prefer attempt** or showing inferred
   relationships.

The profile form clears model, credential, endpoint, executable, and
capability choices when you switch providers. These choices are provider
specific; choose them again for the newly selected provider.

## Data boundaries

Deterministic analysis does not invoke inference. Enrichment is always an
explicit action and receives only a bounded projection of the persisted graph
evidence. It does not receive a repository path, a working directory,
source-reading tools, or edit permissions. The deterministic report remains
authoritative, and inferred relationships are hidden until explicitly shown.

Semantic search is independently opt-in: enable **Use semantic search**, then
choose **Search semantically**. It needs an enabled embedding profile and falls
back to lexical search when none is usable.

## Common issues

- **Analysis finished immediately:** this is normal for a small workspace. A
  successful deterministic analysis is not an AI enrichment attempt.
- **Set up AI enrichment is shown:** no enabled generation profile exists for
  this host. Use the setup action; saving a profile alone does not invoke it.
- **Save provider is unavailable:** follow the displayed next step. Enabled
  generation profiles need an executable or endpoint, model ID, and named
  credential reference. Local Ollama embeddings need an executable and model
  ID, but no credential reference.
- **Enrichment completed but the graph did not change:** choose **Prefer
  attempt**, then explicitly show inferred relationships. This preserves the
  deterministic presentation by default.
- **Archive download fails:** retry only after the run is valid. The archive is
  a short-lived, local download of report artifacts and curation data; it does
  not include source files.

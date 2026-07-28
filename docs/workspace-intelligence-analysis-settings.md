# Workspace Intelligence analysis settings

Open an Engagement’s **Intelligence** view and expand **Analysis scope and
safety budgets** before starting a run. The settings are workspace-local; they
never modify a repository.

- Include and exclude entries are one relative glob per line. Includes narrow
  the supported deterministic source/configuration allowlist; they cannot add
  arbitrary files. Excludes take precedence. Parent traversal and backslashes
  are rejected.
- File count, per-file bytes, per-repository source bytes, time, graph-node,
  and graph-edge controls are hard host-side bounds. The browser values are not
  trusted on their own.
- **Save workspace defaults** changes the policy for future runs. Edited values
  that have not been saved are an explicit one-run override when you choose
  **Analyze workspace**.

Each run records its normalized effective settings. Source or graph budget
truncation is shown as partial coverage with a corresponding observation;
intentional include/exclude scope is also recorded. Changing settings prevents
reuse of a prior repository analysis made under different policy.

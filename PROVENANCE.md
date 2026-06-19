# cbranch — Provenance Record

This record attests that `cbranch` was built under the clean-room process defined in
[`CLEANROOM.md`](CLEANROOM.md). It is maintained alongside the release per `CLEANROOM.md` §6.

## Clean-room attestation (CLEANROOM.md §6)

| Field | Value |
|---|---|
| Product | cbranch |
| Release license | MIT (see [`LICENSE`](LICENSE)) |
| Spec authored | 2026-06-18 |
| Spec author had reference access? | Yes — for inspiration only; encoded **only** functional requirements into the spec. |
| Implementer | cbranch clean-room implementer — fresh, isolated build session. |
| Implementation start | 2026-06-18 |
| Implementer had reference-source access? | **No.** Attest: the implementation was produced solely from the clean artifacts listed below, official Git documentation, and the public documentation of the permissively-licensed libraries named in `docs/spec/03-tech-stack.md`. No source, assets, or proprietary documentation of any other Git GUI or any copyleft reference was sought, read, decompiled, paraphrased, or ported. |
| Spec artifacts relied upon | `docs/spec/` (00–16), [`LICENSES.md`](LICENSES.md), [`BRANDING.md`](BRANDING.md). |
| Excluded from hand-off | `.local/SPEC-AGENT-BRIEF.md` (dirty-side working document) was **not** read or used. |
| Clean-room QA gate run? | Yes — the spec was denylist-scrubbed before hand-off (per `CLEANROOM.md` §7). |
| Dependency license audit | All bundled dependencies are permissive per [`LICENSES.md`](LICENSES.md); the CI license audit is wired from the first scaffold commit. |
| Legal review | Pending. |

## Inputs permitted to the clean side (CLEANROOM.md §2)

1. Everything under `docs/spec/`.
2. `LICENSES.md` and `BRANDING.md`.
3. Git's official public documentation and its command-line interface / output formats.
4. Public documentation of the permissively-licensed libraries named in the stack.
5. General programming knowledge.

Any detail missing from the above was filled from public Git documentation or first-principles
design — never from another product's implementation.

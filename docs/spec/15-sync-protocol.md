# Live-Data Sync: WebSocket Invalidation Bus

> **Status:** authoritative live-data design. Closes audit blocker **#7** (multi-tab / live state) and
> replaces the heavyweight "synced collection" gap (**N1**) with a thin **invalidation bus**. Depends on
> the `repo.subscribe` streaming RPC and `InvalidationEvent` schema in
> [`14-rpc-contract.md`](14-rpc-contract.md). **Stack: TanStack Query (server-cache) + Zustand
> (ephemeral UI). TanStack DB is NOT used** (decision: a single-user app doesn't need differential
> sync / optimistic-rebase; an invalidation bus gives the same perceived liveness for far less code).

---

## 1. Principle

cbranch never streams row-level deltas. The server pushes **which domains changed**; the client
**invalidates and refetches** the affected queries. This is "WebSocket as an invalidation bus."

```
host fs watcher ─► debounce/coalesce ─► map changed paths to DOMAINS
        │                                        │
        │                          InvalidationEvent { repoId, domains }
        ▼                                        ▼
   .git/* + worktree            repo.subscribe stream (one per connection, over the §14 multiplexed WS)
                                                 │
                                                 ▼
                         client: queryClient.invalidateQueries([repoId, domain])  ─► TanStack Query refetch
```

Why this and not the alternatives (single-user context):
- **Not pure polling:** polling lags external (terminal) changes and wastes `git status`/`for-each-ref`
  work on large repos.
- **Not a synced collection:** row-level delta sync + optimistic rebase is bespoke, correctness-heavy,
  and its multi-writer payoff is moot for one user. The lock in `14 §3.2` already serializes the one
  user's writes; a refetch is the only consumer.

---

## 2. Domains and the query-key convention

`Domain` (defined in `14 §5`): `refs | status | stash | worktrees | tags | commits | config | inProgress`.

**Query keys MUST be structured `[repoId, domain, ...params]`** so an invalidation maps mechanically:

| Domain | Backing query method(s) (`14 §7`) | Example query key |
|---|---|---|
| `refs` | `branch.list` | `[repoId, "refs", "branches"]` |
| `tags` | `tag.list` | `[repoId, "tags"]` |
| `status` | `status.get`, `diff.workingFile` | `[repoId, "status"]` |
| `stash` | `stash.list` | `[repoId, "stash"]` |
| `worktrees` | `worktree.list` | `[repoId, "worktrees"]` |
| `commits` | head window of `log.stream`, `fileHistory.stream` | `[repoId, "commits", logQueryHash]` |
| `config` | `config.get`, `remote.list` | `[repoId, "config"]` |
| `inProgress` | `repo.state` | `[repoId, "inProgress"]` |

On `InvalidationEvent { repoId, domains }` the client calls
`queryClient.invalidateQueries({ queryKey: [repoId, domain] })` for each domain. Note `refs` and
`commits` are related: a ref move invalidates both (so labels and the head of the graph refresh).
Immutable reads (`commit.detail`, `commit.diff` of a fixed oid, `blame.get` of a fixed rev) are **never**
invalidated — they're content-addressed by oid and cached indefinitely.

```ts
// client: one subscription per open repo, driven by the ManagedRuntime (14 §2)
AppRuntime.runFork(
  client.RepoSubscribe({ repoId }).pipe(
    Stream.runForEach((ev) => Effect.sync(() => {
      for (const d of ev.domains) queryClient.invalidateQueries({ queryKey: [ev.repoId, d] })
    }))
  )
) // cancel by interrupting this fiber on repo close / unmount
```

---

## 3. Host-side watcher → domain mapping

A filesystem watcher (e.g. **chokidar**) runs per `repoId` on the **common git dir**
(`git rev-parse --git-common-dir`) plus the worktree, with a **debounce/coalesce window (~150 ms)** that
unions all changed paths into one `domains` set per tick.

| Changed path (under the common git dir / worktree) | Domains emitted |
|---|---|
| `HEAD`, `refs/heads/**`, `refs/remotes/**`, `packed-refs` | `refs`, `commits`, `inProgress` |
| `refs/tags/**` | `tags`, `commits` |
| `index`, worktree file add/modify/delete | `status` |
| `refs/stash`, `logs/refs/stash` | `stash` |
| `worktrees/**`, `worktree` admin files | `worktrees` |
| `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/**`, `rebase-apply/**`, `BISECT_LOG`, `sequencer/**` | `inProgress`, `refs` |
| `config` | `config` |

Watcher requirements: ignore `*.lock` and `objects/**` churn (high-volume, irrelevant to UI domains);
coalesce a burst (a single `git` operation touches many paths) into one event; per-`repoId` watcher is
shared across all connections to that repo and torn down when the last subscriber disconnects.

---

## 4. Echo suppression (don't double-refetch your own writes)

When cbranch performs a mutation, the result already invalidates the relevant queries on the calling
client (via `useMutation` `onSettled`, §6). The watcher will *also* fire for that same on-disk change,
which would cause a redundant refetch. Mitigation, in order of preference:

1. **Rely on coalescing + Query dedup first:** the ~150 ms debounce usually absorbs the self-write, and
   TanStack Query dedupes concurrent/just-run refetches, so a redundant invalidation is cheap. This
   alone is acceptable for v1.
2. **Optional suppression window:** the server may mark a short per-`repoId` window after its own
   mutation and drop watcher-emitted domains that match the expected change set. Keep it best-effort;
   never suppress so aggressively that a real concurrent terminal change is missed.

Other connections/tabs are *not* suppressed — they SHOULD receive the invalidation (that's the point).

---

## 5. Reconnect = invalidate-all

The WS can drop (laptop sleep, tunnel restart). On reconnect the client re-establishes the
`repo.subscribe` stream and **invalidates every query for the repo** (`invalidateQueries({ queryKey: [repoId] })`) — a full "resnapshot" is just a refetch of whatever is currently mounted. No missed-event
replay or cursor bookkeeping is needed because the data is re-derivable from the host on demand. While
disconnected, the client shows a non-blocking "reconnecting" indicator (per `12-nonfunctional.md`).

---

## 6. Optimistic mutations (TanStack Query, not a custom rebase)

Use `useMutation` with the standard optimistic pattern — no bespoke machinery:

```ts
useMutation({
  mutationFn: (v) => AppRuntime.runPromise(client.StageFiles(v)),
  onMutate: async (v) => {                       // optimistic
    await queryClient.cancelQueries({ queryKey: [repoId, "status"] })
    const prev = queryClient.getQueryData([repoId, "status"])
    queryClient.setQueryData([repoId, "status"], optimisticApply(prev, v))
    return { prev }
  },
  onError: (_e, _v, ctx) => queryClient.setQueryData([repoId, "status"], ctx.prev), // rollback
  onSettled: () => queryClient.invalidateQueries({ queryKey: [repoId, "status"] }), // reconcile
})
```

Server-side, the mutation takes the per-`repoId` `Semaphore(1)` (`14 §3.2`), so writes are serialized
even across tabs. `GitError` rejections drive `onError` rollback + a typed toast.

---

## 7. Multi-tab / multi-connection semantics (closes #7)

- **Server is the single source of truth.** Active repo is **per-connection** (each tab calls
  `repo.open` and holds its own `repoId` context + its own `repo.subscribe` stream + its own Query cache).
- The **per-`repoId` mutation lock is shared across all connections** — two tabs on the same repo can't
  race a write.
- An on-disk change (from any tab, or the terminal) fires the **one** shared per-`repoId` watcher, which
  pushes `InvalidationEvent` to **every** connection subscribed to that `repoId`; each tab refetches
  independently. No shared client state, no cross-tab broadcast channel needed.
- Ephemeral UI state (theme, panel sizes, palette-open, selection) lives in **Zustand**, per-tab, and is
  never synced — it is not server data.

---

## 8. What does NOT go through this bus
- **Ephemeral UI state** → Zustand (per-tab, local, synchronous). Never in Query, never invalidated.
- **Immutable content reads** (commit detail/diff/blame at a fixed oid) → ordinary cached queries with
  no invalidation.
- **Long pull streams** (`fetch/pull/push` progress, `log.stream` deep scroll) → consumed directly as
  Effect `Stream`s (`14 §3.4`), not as Query data; the head window of history is a query that the
  `commits`/`refs` invalidation refreshes.
- **React Query is the sole feeder for synced data** (this is the N4 rule): do not add a second
  fetch/cache path for the same data.

---

## 9. Open items handed to the spec author
- Pin chokidar (or chosen watcher) and document the ignore globs + debounce window in `12-nonfunctional.md`.
- Define `optimisticApply` helpers per mutation domain (status/refs/stash) — small, pure functions.
- Add the "reconnecting" indicator + offline behavior to `12-nonfunctional.md` (ties to `01` EC-9).
- Confirm `repo.subscribe` interruption tears down the shared watcher when the last subscriber leaves.
- Link this file from `00-README.md`.

// Tiny Effect run helpers for tests (test-only infrastructure).
//
// Centralizes the "run an Effect to a Promise" boilerplate so unit tests read
// linearly. `runScoped` provides a fresh `Scope`, which the engine's `cat-file` pools
// and version probe require; the scope (and thus any spawned processes) is torn down
// when the effect completes.

import { Effect, type Exit, type Scope } from "effect";

export const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

export const runExit = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(effect);

export const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

export const runScopedExit = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.scoped(effect));

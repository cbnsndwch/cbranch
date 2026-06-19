// React context for the host API (NF-TEST-7).
//
// Components read the host through `useApi()`; production wires the runtime-backed
// `CbranchApi` at the root, while component tests wrap their subject in
// `<ApiProvider api={fakeApi}>` — no live host required.

import { createContext, type PropsWithChildren, useContext } from "react";

import { type CbranchApi } from "./api";

const ApiContext = createContext<CbranchApi | null>(null);

export const ApiProvider = ({ api, children }: PropsWithChildren<{ readonly api: CbranchApi }>) => (
  <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
);

/** Access the host {@link CbranchApi}. Throws if used outside an {@link ApiProvider}. */
export const useApi = (): CbranchApi => {
  const api = useContext(ApiContext);
  if (api === null) throw new Error("useApi must be used within <ApiProvider>");
  return api;
};

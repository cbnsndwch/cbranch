import { expect, test } from "vitest";

import { version } from "./index";

test("vscode-ext exposes a version", () => {
  expect(version).toBe("0.0.0");
});

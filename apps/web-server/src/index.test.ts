import { expect, test } from "vitest";

import { version } from "./index";

test("web-server exposes a version", () => {
  expect(version).toBe("0.0.0");
});

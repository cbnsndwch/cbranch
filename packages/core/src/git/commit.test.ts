import { describe, expect, test } from "vitest";

import { parseTzOffsetMinutes } from "./commit";

describe("parseTzOffsetMinutes", () => {
  test("Z ⇒ 0", () => {
    expect(parseTzOffsetMinutes("2023-01-01T00:00:00Z")).toBe(0);
  });
  test("positive and negative offsets ⇒ signed minutes", () => {
    expect(parseTzOffsetMinutes("2023-06-01T12:00:00+02:00")).toBe(120);
    expect(parseTzOffsetMinutes("2023-06-01T12:00:00-05:30")).toBe(-330);
    expect(parseTzOffsetMinutes("2023-06-01T12:00:00+0000")).toBe(0);
  });
  test("unparseable ⇒ 0", () => {
    expect(parseTzOffsetMinutes("nope")).toBe(0);
  });
});

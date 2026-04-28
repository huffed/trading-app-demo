import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseFormWithZod } from "./zod-form";

const sampleSchema = z.object({
  name: z.string().min(1, "Name required"),
  age: z.number().int().min(18, "Must be 18+"),
});

describe("parseFormWithZod", () => {
  it("returns { success: true, data } when input matches", () => {
    const out = parseFormWithZod(sampleSchema, { name: "Jack", age: 30 });
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data).toEqual({ name: "Jack", age: 30 });
    }
  });

  it("flattens issues with paths into fieldErrors", () => {
    const out = parseFormWithZod(sampleSchema, { name: "", age: 12 });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.fieldErrors.name).toBe("Name required");
      expect(out.fieldErrors.age).toBe("Must be 18+");
      expect(out.unmappedErrors).toEqual([]);
    }
  });

  it("keeps only the first message per field when multiple issues fire", () => {
    const strictSchema = z.object({
      name: z.string().min(3, "Too short").regex(/^[A-Z]/, "Must be capitalized"),
    });
    const out = parseFormWithZod(strictSchema, { name: "" });
    expect(out.success).toBe(false);
    if (!out.success) {
      // First issue wins
      expect(out.fieldErrors.name).toBe("Too short");
    }
  });
});

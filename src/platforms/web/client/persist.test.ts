import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { readPersisted, writePersisted } from "./persist";

beforeAll(() => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
});

const KEY = "pico:web:test-key";

afterEach(() => {
  localStorage.removeItem(KEY);
});

describe("readPersisted", () => {
  test("returns the fallback when the key is absent", () => {
    expect(readPersisted(KEY, z.boolean(), true)).toBe(true);
  });

  test("returns the parsed value when it matches the schema", () => {
    writePersisted(KEY, ["a", "b"]);
    expect(readPersisted(KEY, z.array(z.string()), [])).toEqual(["a", "b"]);
  });

  test("returns the fallback when stored json is malformed", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readPersisted(KEY, z.string().nullable(), null)).toBeNull();
  });

  test("returns the fallback when the stored shape fails the schema", () => {
    writePersisted(KEY, { legacy: true });
    expect(readPersisted(KEY, z.array(z.string()), [])).toEqual([]);
  });

  test("round-trips a nullable string", () => {
    writePersisted<string | null>(KEY, "conv-1");
    expect(readPersisted(KEY, z.string().nullable(), null)).toBe("conv-1");
    writePersisted<string | null>(KEY, null);
    expect(readPersisted(KEY, z.string().nullable(), "x")).toBeNull();
  });
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { readCookieFile } from "./browser-cookie-file.ts";

const readExport = async (
  input: object | string,
  decode = (path: string) => readCookieFile({ path }),
) => {
  const directory = await mkdtemp(join(tmpdir(), "pico-cookie-parser-"));
  try {
    const path = join(directory, "export.json");
    await writeFile(path, typeof input === "string" ? input : JSON.stringify(input));
    return await decode(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const cookie = { name: "synthetic-name", value: "synthetic-secret", domain: "example.test" };

it("preserves explicit host scope over export dots and rejects domain scope on IP addresses", async () => {
  const cookies = await readExport([
    { ...cookie, domain: ".EXAMPLE.test", hostOnly: true },
    { ...cookie, hostOnly: false },
    { ...cookie, domain: ".example.test" },
    cookie,
    { ...cookie, domain: "127.0.0.1", hostOnly: true },
  ]);
  assert.deepEqual(
    cookies.map((entry) => entry.domain),
    ["example.test", ".example.test", ".example.test", "example.test", "127.0.0.1"],
  );
  for (const domain of ["127.0.0.1", "127.1", "[::1]"])
    await assert.rejects(readExport([{ ...cookie, domain, hostOnly: false }]));
});

it("distinguishes session sentinels, explicit sessions, and expired persistent cookies", async () => {
  const cookies = await readExport({
    cookies: [
      { ...cookie, expirationDate: 1, session: false },
      { ...cookie, expires: 2, expirationDate: 2 },
      { ...cookie, expires: -1 },
      { ...cookie, expirationDate: 2, session: true },
      cookie,
    ],
    exportedAt: "synthetic export metadata",
  });
  assert.deepEqual(
    cookies.map((entry) => entry.expires),
    [1, 2, undefined, undefined, undefined],
  );
  for (const metadata of [
    { expires: 1, expirationDate: 2 },
    { expires: 1, expirationDate: 2, session: true },
    { session: false },
    { session: false, expires: -1 },
    { expires: -0.5 },
    { expirationDate: "123" },
  ])
    await assert.rejects(readExport([{ ...cookie, ...metadata }]));
});

it("normalizes SameSite aliases without turning unspecified into None or upgrading Secure", async () => {
  const cookies = await readExport([
    { ...cookie, sameSite: "sTrIcT" },
    { ...cookie, sameSite: "LAX" },
    { ...cookie, sameSite: "no_restriction", secure: true },
    { ...cookie, sameSite: "NONE", secure: true },
    { ...cookie, sameSite: "unspecified" },
  ]);
  assert.deepEqual(
    cookies.map((entry) => entry.sameSite),
    ["Strict", "Lax", "None", "None", undefined],
  );
  await assert.rejects(readExport([{ ...cookie, sameSite: "None", secure: false }]));
  await assert.rejects(readExport([{ ...cookie, sameSite: "unknown" }]));
});

it("rejects partition semantics and malformed records without exposing any input", async () => {
  for (const metadata of [
    { partitionKey: { topLevelSite: "https://synthetic-secret.test" } },
    { partitionKey: "synthetic-secret" },
    { partitionKeyOpaque: true },
    { partitioned: true },
    { partitioned: "false" },
    { firstPartyDomain: "synthetic-secret.test" },
    { httpOnly: "false" },
    { path: "private" },
    { domain: "https://synthetic-secret.test" },
    { value: null },
  ]) {
    await assert.rejects(readExport([cookie, { ...cookie, ...metadata }]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(cookie.name));
      assert.ok(!error.message.includes(cookie.value));
      assert.ok(!error.message.includes(cookie.domain));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  await assert.rejects(readExport([]));
  await assert.rejects(readExport({ cookies: [] }));
});

it("splits a copied Cookie header at the first equals without decoding or unquoting values", async () => {
  const cookies = await readExport(
    '\r\n cOoKiE: auth = padded==inside= ; csrf = %2B%3D+literal ; empty = ; quoted = "literal==" ; \r\n',
    (path) =>
      readCookieFile({ path, format: "header", url: "https://example.test/private?query#hash" }),
  );
  assert.deepEqual(
    cookies.map(({ name, value }) => [name, value]),
    [
      ["auth", "padded==inside="],
      ["csrf", "%2B%3D+literal"],
      ["empty", ""],
      ["quoted", '"literal=="'],
    ],
  );
});

it("rejects ambiguous or malformed whole headers without exposing the file contents", async () => {
  for (const input of [
    "",
    "Cookie:",
    "synthetic-secret=value; missing-equals",
    "synthetic-secret=value;; other=value",
    "synthetic-secret=first; synthetic-secret=second",
    "=synthetic-secret",
    "bad name=synthetic-secret",
    "synthetic-secret=first\nother=second",
    "synthetic-secret=first\u0000second",
    "Set-Cookie:synthetic-secret=value; Path=/",
    "curl -H 'Cookie: synthetic-secret=value'",
  ])
    await assert.rejects(
      readExport(input, (path) =>
        readCookieFile({ path, format: "header", url: "https://example.test" }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("synthetic-secret"));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  await assert.rejects(readExport("synthetic-secret=value"));
  await assert.rejects(
    readExport("[malformed synthetic-secret", (path) => readCookieFile({ path, format: "json" })),
  );
});

it("requires an explicit valid target for header files even without schema validation", async () => {
  for (const options of [
    { format: "header" },
    { format: "header", url: 42 },
    { format: "header", url: "synthetic-secret" },
    { format: "header", url: "ftp://synthetic-secret.test" },
    { format: "header", url: "https://user:synthetic-secret@example.test" },
    { format: "header", url: "https://.synthetic-secret.test" },
    { format: "header", url: "https://synthetic-secret.test\n" },
    { format: "automatic" },
    { format: "json", url: "https://synthetic-secret.test" },
  ])
    await assert.rejects(
      readExport("synthetic-secret=value", (path) =>
        Reflect.apply(readCookieFile, undefined, [{ path, ...options }]),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("synthetic-secret"));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
});

it("enforces secure cookie prefixes before handing the batch to Chrome", async () => {
  const input = "__Host-auth=synthetic-secret; __Secure-csrf=synthetic-csrf";
  await assert.rejects(
    readExport(input, (path) =>
      readCookieFile({ path, format: "header", url: "http://example.test" }),
    ),
  );
  const cookies = await readExport(input, (path) =>
    readCookieFile({ path, format: "header", url: "https://example.test/private" }),
  );
  assert.deepEqual(
    cookies.map(({ domain, path, secure }) => ({ domain, path, secure })),
    [
      { domain: "example.test", path: "/", secure: true },
      { domain: "example.test", path: "/", secure: true },
    ],
  );
  for (const metadata of [{ hostOnly: false }, { path: "/private" }])
    await assert.rejects(
      readExport([{ ...cookie, name: "__Host-auth", secure: true, ...metadata }]),
    );
});

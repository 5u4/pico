import { describe, expect, test } from "bun:test";
import { scrub } from "./redact.ts";

describe("scrub", () => {
  test("redacts a github token", () => {
    expect(scrub("token ghp_16C7e42F292c6912E7710c838347Ae178B4a here")).toBe(
      "token [REDACTED] here",
    );
  });

  test("redacts a github fine-grained pat", () => {
    expect(
      scrub(
        "pat github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwx1234567890 done",
      ),
    ).toBe("pat [REDACTED] done");
  });

  test("redacts an openai key", () => {
    expect(scrub("key sk-abcdefghijklmnopqrstuvwxyz0123 end")).toBe(
      "key [REDACTED] end",
    );
  });

  test("redacts an anthropic key", () => {
    expect(scrub("key sk-ant-abcdefghijklmnopqrstuvwxyz0123 end")).toBe(
      "key [REDACTED] end",
    );
  });

  test("redacts a jwt", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(scrub(`here is ${jwt} ok`)).toBe("here is [REDACTED] ok");
  });

  test("redacts a pem private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabcd/efgh+1234\n-----END RSA PRIVATE KEY-----";
    expect(scrub(`before\n${pem}\nafter`)).toBe(
      "before\n[REDACTED PRIVATE KEY]\nafter",
    );
  });

  test("redacts a bearer token", () => {
    expect(scrub("Authorization: Bearer abcdef0123456789ABCDEF")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  test("redacts an aws access key id", () => {
    expect(scrub("id AKIAIOSFODNN7EXAMPLE end")).toBe("id [REDACTED] end");
  });

  test("redacts a slack token", () => {
    expect(scrub("t xoxb-1234567890-abcdefghij end")).toBe("t [REDACTED] end");
  });

  test("redacts multiple secrets in one string", () => {
    expect(
      scrub(
        "a ghp_16C7e42F292c6912E7710c838347Ae178B4a b sk-abcdefghijklmnopqrstuvwxyz0123 c",
      ),
    ).toBe("a [REDACTED] b [REDACTED] c");
  });

  test("leaves ordinary prose unchanged", () => {
    const s = "The quick brown fox jumps over commit a1b2c3d and issue 12345.";
    expect(scrub(s)).toBe(s);
  });
});

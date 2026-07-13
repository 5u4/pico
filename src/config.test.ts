import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config.ts";

describe("parseConfig", () => {
	test("accepts a valid config", () => {
		const result = parseConfig({ name: "pico", port: 8080 });
		expect(result.isOk()).toBe(true);
		expect(result._unsafeUnwrap()).toEqual({ name: "pico", port: 8080 });
	});

	test("rejects a non-positive port with an error message", () => {
		const result = parseConfig({ name: "pico", port: -1 });
		expect(result.isErr()).toBe(true);
	});
});

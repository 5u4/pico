import { describe, expect, test } from "bun:test";
import { assertNever } from "./assert.ts";

type Shape = { kind: "circle" } | { kind: "square" };

function name(shape: Shape): string {
    switch (shape.kind) {
        case "circle":
            return "circle";
        case "square":
            return "square";
        default:
            return assertNever(shape);
    }
}

describe("assertNever", () => {
    test("returns for every handled variant", () => {
        expect(name({ kind: "circle" })).toBe("circle");
        expect(name({ kind: "square" })).toBe("square");
    });

    test("throws when reached with an unhandled value", () => {
        expect(() => assertNever("rogue" as never)).toThrow("Unreachable");
    });
});

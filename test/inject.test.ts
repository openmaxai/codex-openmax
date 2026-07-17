import { describe, it, expect } from "vitest";
import { classifyFailure } from "../src/adapter/invariants.js";

// Placeholder: the P2 killing regressions live here -- no-turn injection, ok:true truly-delivered,
// bounded polling / backpressure.
describe("codex-openmax scaffold", () => {
	it("classifyFailure defaults to unknown (scaffold)", () => {
		expect(classifyFailure(new Error("x"))).toBe("unknown");
	});
});

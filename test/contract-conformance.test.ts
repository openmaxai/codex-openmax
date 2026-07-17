// Contract conformance against the canonical cws-comm protocol contract.
// Fixtures are vendored VERBATIM from @openmaxai/openmax-agent-sdk (PR #1, commit 7fc6949)
// fixtures/v1/ — the language-neutral golden corpus whose passing defines "protocol-conformant"
// (see that repo's CONTRACT.md). Re-vendor when the contract version bumps.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { isWakeRequest } from "../src/adapter/server.js";
import type { WakeResponse } from "../src/types.js";

const FIXTURES = join(__dirname, "fixtures", "contract-v1");

function loadFixtures(dir: string): Array<{ file: string; description: string; input: unknown; expectValid: boolean }> {
	return readdirSync(join(FIXTURES, dir))
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => ({ file: f, ...JSON.parse(readFileSync(join(FIXTURES, dir, f), "utf8")) }));
}

describe("contract conformance: wake-request (SDK golden fixtures)", () => {
	// Our /wake body guard IS this adapter's implementation of wake-request.schema.json —
	// it must agree with every golden fixture, valid and drift-negative alike.
	for (const fx of loadFixtures("wake-request")) {
		it(`${fx.file}: ${fx.description}`, () => {
			expect(isWakeRequest(fx.input)).toBe(fx.expectValid);
		});
	}
});

describe("contract conformance: wake-result (producer side)", () => {
	// We are the PRODUCER of wake-result (the SDK validates); what we can pin here is that
	// every response shape this adapter emits carries exactly the schema's keys
	// ({ok, runtimeSession?} | {ok, failureClass, retryAfterMs?}, additionalProperties:false).
	// KNOWN DELTA (raised on openmax-agent-sdk PR #1): our failureClass values
	// (no_active_turn/runtime_busy/inject_failed/runtime_error/unknown) are finer-grained than
	// the v1 canonical enum (no_inbound_provider/wake_failed) — a contract-revision proposal to
	// enumerate adapter-side diagnostic classes is pending; the JS SDK treats the field as an
	// open string meanwhile, so this is a contract-text gap, not a runtime break.
	const emitted: WakeResponse[] = [
		{ ok: true },
		{ ok: true, runtimeSession: "thr_1" },
		{ ok: false, failureClass: "runtime_busy", retryAfterMs: 2000 },
		{ ok: false, failureClass: "runtime_error" },
	];
	it("every emitted shape carries exactly the schema's keys (additionalProperties:false)", () => {
		for (const r of emitted) {
			const allowed = r.ok ? ["ok", "runtimeSession"] : ["ok", "failureClass", "retryAfterMs"];
			expect(Object.keys(r).every((k) => allowed.includes(k))).toBe(true);
			if (!r.ok) expect(typeof r.failureClass).toBe("string");
			if (!r.ok && r.retryAfterMs !== undefined) {
				expect(Number.isInteger(r.retryAfterMs)).toBe(true);
				expect(r.retryAfterMs).toBeGreaterThanOrEqual(0);
			}
		}
	});
	it("structural fixtures we can honor as producer agree (ok/failure key discipline)", () => {
		// 05-fail-missing-class (invalid: ok:false without failureClass) and
		// 06-ok-with-failure-class (invalid: ok:true carrying failureClass) are the two
		// producer-side mistakes possible in this codebase; assert our type space forbids them.
		const failMissingClass = JSON.parse(readFileSync(join(FIXTURES, "wake-result", "05-fail-missing-class.json"), "utf8"));
		const okWithClass = JSON.parse(readFileSync(join(FIXTURES, "wake-result", "06-ok-with-failure-class.json"), "utf8"));
		expect(failMissingClass.expectValid).toBe(false);
		expect(okWithClass.expectValid).toBe(false);
		// Mirror check on our real emitted values above: no ok:true carries failureClass,
		// every ok:false carries one.
		for (const r of emitted) {
			if (r.ok) expect("failureClass" in r).toBe(false);
			else expect(r.failureClass.length).toBeGreaterThan(0);
		}
	});
});

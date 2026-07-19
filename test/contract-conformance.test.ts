// Contract conformance against the canonical cws-comm protocol contract.
// Fixtures are vendored VERBATIM from @openmaxai/openmax-agent-sdk@0.1.0-alpha.2
// fixtures/v1/ — the language-neutral golden corpus whose passing defines "protocol-conformant"
// (see that repo's CONTRACT.md). Re-vendor when the contract version bumps.
// The canonical failureClass enum is read from the INSTALLED SDK's schema at test time, so a
// contract bump that changes the enum fails here instead of drifting silently.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { isWakeRequest } from "../src/adapter/server.js";
import type { WakeResponse } from "../src/types.js";

const FIXTURES = join(__dirname, "fixtures", "contract-v1");
const SDK_SCHEMAS = join(__dirname, "..", "node_modules", "@openmaxai", "openmax-agent-sdk", "schemas", "v1");

const CANONICAL_FAILURE_CLASSES: string[] = JSON.parse(
	readFileSync(join(SDK_SCHEMAS, "failure-class.schema.json"), "utf8"),
).enum;

function loadFixtures(dir: string): Array<{ file: string; description: string; input: unknown; expectValid: boolean }> {
	return readdirSync(join(FIXTURES, dir))
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => ({ file: f, ...JSON.parse(readFileSync(join(FIXTURES, dir, f), "utf8")) }));
}

/** Exact implementation of wake-result.schema.json (oneOf success/failure,
 * failureClass = canonical enum by $ref, additionalProperties:false both branches). */
function isWakeResult(v: unknown): boolean {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const o = v as Record<string, unknown>;
	if (o.ok === true) {
		if (!Object.keys(o).every((k) => k === "ok" || k === "runtimeSession")) return false;
		return !("runtimeSession" in o) || typeof o.runtimeSession === "string";
	}
	if (o.ok === false) {
		if (!Object.keys(o).every((k) => ["ok", "failureClass", "retryAfterMs"].includes(k))) return false;
		if (typeof o.failureClass !== "string" || !CANONICAL_FAILURE_CLASSES.includes(o.failureClass)) return false;
		if ("retryAfterMs" in o) {
			return typeof o.retryAfterMs === "number" && Number.isInteger(o.retryAfterMs) && o.retryAfterMs >= 0;
		}
		return true;
	}
	return false;
}

describe("contract conformance: wake-request (SDK golden fixtures)", () => {
	// Our /wake body guard IS this adapter's implementation of wake-request.schema.json —
	// it must agree with every golden fixture, valid and drift-negative alike
	// (incl. 04-sender-less: senderId is OPTIONAL, a sender-less wake is legal).
	for (const fx of loadFixtures("wake-request")) {
		it(`${fx.file}: ${fx.description}`, () => {
			expect(isWakeRequest(fx.input)).toBe(fx.expectValid);
		});
	}
});

describe("contract conformance: wake-result (producer side)", () => {
	// We are the PRODUCER of wake-result. Two obligations, both enforced strictly:
	// (a) our local validator must agree with every golden fixture — including
	//     07-unknown-failure-class, the drift alarm that rejects unenumerated classes;
	// (b) every response shape this adapter can emit must pass that validator, i.e.
	//     failureClass on the wire is ALWAYS the canonical v1 enum. The adapter's
	//     finer-grained diagnostics (types.ts FailureClass) never leave the process —
	//     they only inform retryAfterMs and logging.
	for (const fx of loadFixtures("wake-result")) {
		it(`${fx.file}: ${fx.description}`, () => {
			expect(isWakeResult(fx.input)).toBe(fx.expectValid);
		});
	}

	it("canonical enum in the installed SDK is what our wire type promises", () => {
		// If the SDK revises the enum (e.g. accepting the adapter-classes proposal),
		// this pins the moment: update WireFailureClass + the mapping, then re-vendor.
		expect(CANONICAL_FAILURE_CLASSES).toEqual(["no_inbound_provider", "wake_failed"]);
	});

	it("every emitted response shape validates against wake-result.schema.json (enum-strict)", () => {
		// One sample per emission site/path in this codebase:
		const emitted: WakeResponse[] = [
			{ ok: true }, // inject delivered (no session id)
			{ ok: true, runtimeSession: "thr_1" }, // inject delivered
			{ ok: false, failureClass: "wake_failed", retryAfterMs: 2000 }, // wake-queue backpressure shed (internal: runtime_busy)
			{ ok: false, failureClass: "wake_failed", retryAfterMs: 5000 }, // inject unconfirmed (internal: inject_failed)
			{ ok: false, failureClass: "wake_failed", retryAfterMs: 15_000 }, // server/sdk-bridge catch (internal: runtime_error)
			{ ok: false, failureClass: "wake_failed" }, // auth-terminal (no backoff hint)
		];
		for (const r of emitted) expect(isWakeResult(r)).toBe(true);
	});
});

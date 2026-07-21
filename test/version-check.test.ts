import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compareSemver, resolveVersionCheckSchedule, readLocalVersion, makeVersionCheck, type CommForNotify } from "../src/version-check.js";
import type { ConfigProvider } from "../src/runtime-config.js";
import type { OrgConfig } from "../src/config.js";

const quietLog = { info() {}, warn() {}, error() {} };

describe("compareSemver（含 prerelease 排序）", () => {
	it("当比较 prerelease 与正式版时，prerelease 应小于同核心的正式版", () => {
		expect(compareSemver("0.1.0-alpha.3", "0.1.0")).toBe(-1);
		expect(compareSemver("0.1.0", "0.1.0-alpha.3")).toBe(1);
	});
	it("当比较两个 alpha 时，应按数字后缀排序", () => {
		expect(compareSemver("0.1.0-alpha.3", "0.1.0-alpha.4")).toBe(-1);
		expect(compareSemver("0.1.0-alpha.4", "0.1.0-alpha.3")).toBe(1);
	});
	it("当核心版本不同时，应按主次修订排序", () => {
		expect(compareSemver("0.2.0", "0.1.0")).toBe(1);
		expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
	});
});

describe("resolveVersionCheckSchedule", () => {
	it("当未显式启用时，默认应为禁用", () => {
		expect(resolveVersionCheckSchedule()).toEqual({ enabled: false });
		expect(resolveVersionCheckSchedule({})).toEqual({ enabled: false });
		expect(resolveVersionCheckSchedule({ intervalHours: 6 })).toEqual({ enabled: false });
	});
	it("当启用时，intervalHours 缺省应为 24，并换算出 intervalMs", () => {
		expect(resolveVersionCheckSchedule({ enabled: true })).toEqual({ enabled: true, intervalHours: 24, intervalMs: 24 * 3600_000 });
		expect(resolveVersionCheckSchedule({ enabled: true, intervalHours: 6 })).toEqual({ enabled: true, intervalHours: 6, intervalMs: 6 * 3600_000 });
	});
});

describe("readLocalVersion", () => {
	it("应从仓库 package.json 读到与之一致的版本（验证相对路径深度）", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
		expect(readLocalVersion()).toBe(pkg.version);
	});
});

function stubProvider(orgs: Array<Partial<OrgConfig>>): ConfigProvider {
	return { enabledOrgs: () => orgs as OrgConfig[] } as unknown as ConfigProvider;
}
function recordingComm(): { comm: CommForNotify; dms: string[]; sent: Array<{ conversationId: string; content: string }> } {
	const dms: string[] = [];
	const sent: Array<{ conversationId: string; content: string }> = [];
	const comm: CommForNotify = {
		createDm: async ({ peerMemberId }) => {
			dms.push(peerMemberId);
			return { conversation: { id: `dm_${peerMemberId}` } };
		},
		send: async (p) => {
			sent.push(p);
		},
	};
	return { comm, dms, sent };
}

describe("makeVersionCheck", () => {
	it("当发现更新版时，应向 owner 发送一次通知，且重复轮询只通知一次", async () => {
		const provider = stubProvider([{ org_id: "o1", owner: { member_id: "owner_1", name: "" } }]);
		const { comm, sent } = recordingComm();
		const check = makeVersionCheck({ provider, comm, log: quietLog, localVersion: "0.1.0-alpha.3", fetchLatest: async () => "0.1.0-alpha.4" });
		await check();
		await check(); // 同一 latest：应被去重
		expect(sent).toHaveLength(1);
		expect(sent[0].conversationId).toBe("dm_owner_1");
		expect(sent[0].content).toContain("0.1.0-alpha.3");
		expect(sent[0].content).toContain("0.1.0-alpha.4");
	});

	it("当本地已是最新（相等或更旧）时，应不通知", async () => {
		const provider = stubProvider([{ org_id: "o1", owner: { member_id: "owner_1", name: "" } }]);
		const same = recordingComm();
		await makeVersionCheck({ provider, comm: same.comm, log: quietLog, localVersion: "0.1.0-alpha.3", fetchLatest: async () => "0.1.0-alpha.3" })();
		expect(same.sent).toHaveLength(0);

		const older = recordingComm();
		await makeVersionCheck({ provider, comm: older.comm, log: quietLog, localVersion: "0.2.0", fetchLatest: async () => "0.1.0" })();
		expect(older.sent).toHaveLength(0);
	});

	it("当 org 没有 owner.member_id 时，应跳过而不报错", async () => {
		const provider = stubProvider([{ org_id: "o1", owner: { member_id: "", name: "" } }]);
		const { comm, sent } = recordingComm();
		await makeVersionCheck({ provider, comm, log: quietLog, localVersion: "0.1.0", fetchLatest: async () => "0.2.0" })();
		expect(sent).toHaveLength(0);
	});

	it("当 fetch 失败时，应 fail-open 不抛异常且不通知", async () => {
		const provider = stubProvider([{ org_id: "o1", owner: { member_id: "owner_1", name: "" } }]);
		const { comm, sent } = recordingComm();
		await expect(
			makeVersionCheck({
				provider,
				comm,
				log: quietLog,
				localVersion: "0.1.0",
				fetchLatest: async () => {
					throw new Error("registry down");
				},
			})(),
		).resolves.toBeUndefined();
		expect(sent).toHaveLength(0);
	});
});

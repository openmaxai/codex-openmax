import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type OrgConfig } from "../src/config.js";
import { buildConfigProvider } from "../src/runtime-config.js";
import { handleConfigEvent } from "../src/config-events.js";
import { makeSyncSelf } from "../src/owner-sync.js";

const quietLog = { info() {}, warn() {}, error() {} };

const BASE = {
	enabled: true,
	server: { bff_url: "https://x", ws_url: "wss://x", frontend_base_path: "/workspace" },
	agent: { identity_id: "id_1", api_key: "cwsk_x", device_id: "dev_1", app_version: "codex-openmax/9.9.9" },
	orgs: {
		org_1: {
			enabled: true,
			org_id: "org_1",
			org_name: "Org One",
			owner: { member_id: "", name: "" },
			self: { member_id: "m_self", name: "Codex", display_name: "Codex" },
			access: { dmPolicy: "owner", dmAllowFrom: [] as string[], groupPolicy: "allowlist", groups: {} as Record<string, unknown> },
		},
	},
	codex: { bin: "codex", cwd: "/tmp" },
	bridge: { localHttpPort: 8787 },
};

let currentPath = "";
function setup(overrides?: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "codex-cfgev-"));
	const p = join(dir, "config.json");
	writeFileSync(p, JSON.stringify(overrides ? { ...BASE, ...overrides } : BASE));
	currentPath = p;
	const cfg = loadConfig(p);
	const provider = buildConfigProvider(cfg, p, quietLog);
	const org = provider.enabledOrgs()[0];
	return { p, provider, org, reloadedOrg: (): OrgConfig => loadConfig(p).orgs[0] };
}
afterEach(() => {
	if (currentPath) rmSync(currentPath, { force: true });
	currentPath = "";
});

describe("handleConfigEvent — DM 策略", () => {
	it("当收到有效 dm_policy_changed 时，应更新 access.dmPolicy、落盘并同步到传入的 orgConfig", async () => {
		const { provider, org, reloadedOrg } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.dm_policy_changed", data: { policy: "open" } }, { log: quietLog });
		expect(org.access.dmPolicy).toBe("open"); // 传入的 SDK 实时副本已更新
		expect(reloadedOrg().access.dmPolicy).toBe("open"); // 已落盘并可 round-trip
	});

	it("当 dm_policy_changed 携带非法 policy 时，应拒绝且不修改", async () => {
		const { provider, org, reloadedOrg } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.dm_policy_changed", data: { policy: "bogus" } }, { log: quietLog });
		expect(org.access.dmPolicy).toBe("owner");
		expect(reloadedOrg().access.dmPolicy).toBe("owner");
	});
});

describe("handleConfigEvent — DM 白名单 add/remove/set", () => {
	it("当 action=add 时，应并集去重地追加成员并落盘", async () => {
		const { provider, org, reloadedOrg } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.dm_allowlist_changed", data: { action: "add", member_ids: ["a", "b", "a"] } }, { log: quietLog });
		expect(org.access.dmAllowFrom).toEqual(["a", "b"]);
		expect(reloadedOrg().access.dmAllowFrom).toEqual(["a", "b"]);
	});

	it("当 action=remove 时，应移除指定成员", async () => {
		const { provider, org } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.dm_allowlist_changed", data: { action: "add", member_ids: ["a", "b", "c"] } }, { log: quietLog });
		await handleConfigEvent(provider, org, { event: "agent.config.dm_allowlist_changed", data: { action: "remove", member_ids: ["b"] } }, { log: quietLog });
		expect(org.access.dmAllowFrom).toEqual(["a", "c"]);
	});

	it("当 action=set 时，应整体替换白名单", async () => {
		const { provider, org, reloadedOrg } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.dm_allowlist_changed", data: { action: "add", member_ids: ["x"] } }, { log: quietLog });
		await handleConfigEvent(provider, org, { event: "agent.config.dm_allowlist_changed", data: { action: "set", member_ids: ["p", "q"] } }, { log: quietLog });
		expect(reloadedOrg().access.dmAllowFrom).toEqual(["p", "q"]);
	});

	it("当 member_ids 为空时，应拒绝", async () => {
		const { provider, org } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.dm_allowlist_changed", data: { action: "add", member_ids: [] } }, { log: quietLog });
		expect(org.access.dmAllowFrom).toEqual([]);
	});
});

describe("handleConfigEvent — 群策略", () => {
	it("当 group_mode_changed=mention 时，应写入该会话的 mode", async () => {
		const { provider, org, reloadedOrg } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.group_mode_changed", data: { conversation_id: "c1", mode: "mention" } }, { log: quietLog });
		expect(org.access.groups?.c1).toEqual({ allowFrom: ["*"], mode: "mention" });
		expect(reloadedOrg().access.groups?.c1?.mode).toBe("mention");
	});

	it("当 group_mode_changed=silent 时，应删除该会话条目", async () => {
		const { provider, org, reloadedOrg } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.group_mode_changed", data: { conversation_id: "c1", mode: "mention" } }, { log: quietLog });
		await handleConfigEvent(provider, org, { event: "agent.config.group_mode_changed", data: { conversation_id: "c1", mode: "silent" } }, { log: quietLog });
		expect(org.access.groups?.c1).toBeUndefined();
		expect(reloadedOrg().access.groups?.c1).toBeUndefined();
	});

	it("当 group_mode_changed 携带非法 mode 时，应拒绝", async () => {
		const { provider, org } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.group_mode_changed", data: { conversation_id: "c1", mode: "bogus" } }, { log: quietLog });
		expect(org.access.groups?.c1).toBeUndefined();
	});

	it("当 group_allowfrom_changed 时，应写入该会话的 allowFrom", async () => {
		const { provider, org, reloadedOrg } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.group_allowfrom_changed", data: { conversation_id: "c1", allow_from: ["u1", "u2"] } }, { log: quietLog });
		expect(org.access.groups?.c1?.allowFrom).toEqual(["u1", "u2"]);
		expect(reloadedOrg().access.groups?.c1?.allowFrom).toEqual(["u1", "u2"]);
	});

	it("当 group_scope_changed 有效时应更新 groupPolicy，非法 scope 应拒绝", async () => {
		const { provider, org, reloadedOrg } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.group_scope_changed", data: { scope: "disabled" } }, { log: quietLog });
		expect(reloadedOrg().access.groupPolicy).toBe("disabled");
		await handleConfigEvent(provider, org, { event: "agent.config.group_scope_changed", data: { scope: "bogus" } }, { log: quietLog });
		expect(reloadedOrg().access.groupPolicy).toBe("disabled");
	});

	it("当 group_allowlist_changed add/remove/set 时，应相应增删/整体替换群条目", async () => {
		const { provider, org, reloadedOrg } = setup();
		await handleConfigEvent(provider, org, { event: "agent.config.group_allowlist_changed", data: { action: "add", conversation_ids: ["c1", "c2"] } }, { log: quietLog });
		expect(Object.keys(org.access.groups ?? {}).sort()).toEqual(["c1", "c2"]);
		await handleConfigEvent(provider, org, { event: "agent.config.group_allowlist_changed", data: { action: "remove", conversation_ids: ["c1"] } }, { log: quietLog });
		expect(Object.keys(org.access.groups ?? {})).toEqual(["c2"]);
		await handleConfigEvent(provider, org, { event: "agent.config.group_allowlist_changed", data: { action: "set", conversation_ids: ["c3"] } }, { log: quietLog });
		expect(Object.keys(reloadedOrg().access.groups ?? {})).toEqual(["c3"]);
	});
});

describe("handleConfigEvent — owner_changed（拉取式、防伪造）", () => {
	it("当收到 owner_changed 时，应触发从 core 的拉取式 re-sync，忽略帧里携带的 new_owner_member_id", async () => {
		const { provider, org } = setup();
		// core 权威记录：owner_member_id=core_owner；而帧谎称 attacker_999。
		const http = {
			apiPath: (path: string) => `/api/v1${path}`,
			getForOrg: async (_orgId: string, path: string) => {
				if (path.endsWith("/members/m_self")) return { display_name: "Codex", owner_member_id: "core_owner" };
				if (path.endsWith("/members/core_owner")) return { display_name: "Real Owner" };
				throw new Error(`unexpected ${path}`);
			},
		};
		const resyncOwner = makeSyncSelf(http, provider, quietLog);
		await handleConfigEvent(
			provider,
			org,
			{ event: "agent.config.owner_changed", data: { old_owner_member_id: "", new_owner_member_id: "attacker_999" } },
			{ log: quietLog, resyncOwner },
		);
		expect(org.owner).toEqual({ member_id: "core_owner", name: "Real Owner" }); // 来自 core，而非帧
	});
});

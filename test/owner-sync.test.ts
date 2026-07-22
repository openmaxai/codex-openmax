import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type OrgConfig } from "../src/config.js";
import { buildConfigProvider } from "../src/runtime-config.js";
import { makeSyncSelf, type HttpForOrg } from "../src/owner-sync.js";

const quietLog = { info() {}, warn() {}, error() {} };

function baseConfig(owner = { member_id: "", name: "" }) {
	return {
		enabled: true,
		server: { bff_url: "https://x", ws_url: "wss://x", frontend_base_path: "/workspace" },
		agent: { identity_id: "id_1", api_key: "cwsk_x", device_id: "dev_1", app_version: "codex-openmax/9.9.9" },
		orgs: {
			org_1: {
				enabled: true,
				org_id: "org_1",
				org_name: "Org One",
				owner,
				self: { member_id: "m_self", name: "Codex", display_name: "Codex" },
				access: { dmPolicy: "owner", dmAllowFrom: [], groupPolicy: "allowlist", groups: {} },
			},
		},
		codex: { bin: "codex", cwd: "/tmp" },
		bridge: { localHttpPort: 8787 },
	};
}

let currentPath = "";
function setup(owner?: { member_id: string; name: string }) {
	const dir = mkdtempSync(join(tmpdir(), "codex-ownersync-"));
	const p = join(dir, "config.json");
	writeFileSync(p, JSON.stringify(baseConfig(owner)));
	currentPath = p;
	const cfg = loadConfig(p);
	const provider = buildConfigProvider(cfg, p, quietLog);
	return { p, provider, org: provider.enabledOrgs()[0], reloadedOrg: (): OrgConfig => loadConfig(p).orgs[0] };
}
afterEach(() => {
	if (currentPath) rmSync(currentPath, { force: true });
	currentPath = "";
});

function fakeHttp(members: Record<string, Record<string, unknown>>): HttpForOrg {
	return {
		apiPath: (path: string) => `/api/v1${path}`,
		getForOrg: async (_orgId: string, path: string) => {
			const m = path.match(/\/members\/([^/]+)$/);
			const id = m?.[1] ?? "";
			if (members[id]) return members[id];
			throw new Error(`404 ${path}`);
		},
	};
}

describe("makeSyncSelf", () => {
	it("当 core 返回 display_name 与 owner 时，应写回 self.display_name+owner，落盘，并返回 nameReady", async () => {
		const { provider, org, reloadedOrg } = setup();
		const http = fakeHttp({
			m_self: { display_name: "Codex Prime", owner_member_id: "owner_1" },
			owner_1: { display_name: "Owner One" },
		});
		const res = await makeSyncSelf(http, provider, quietLog)(org);
		expect(res).toEqual({ nameReady: true, displayName: "Codex Prime" });
		expect(org.self.display_name).toBe("Codex Prime");
		expect(org.owner).toEqual({ member_id: "owner_1", name: "Owner One" });
		// 已落盘且可 round-trip
		expect(reloadedOrg().self.display_name).toBe("Codex Prime");
		expect(reloadedOrg().owner).toEqual({ member_id: "owner_1", name: "Owner One" });
	});

	it("当 core 未记录 owner 时，绝不清空本地已绑定的 owner（首触自动绑定不变式）", async () => {
		const { provider, org } = setup({ member_id: "local_owner", name: "Local" });
		const http = fakeHttp({ m_self: { display_name: "Codex", owner_member_id: "" } });
		const res = await makeSyncSelf(http, provider, quietLog)(org);
		expect(res.nameReady).toBe(true);
		expect(org.owner).toEqual({ member_id: "local_owner", name: "Local" }); // 未被清空
	});

	it("当 self.member_id 缺失时，应返回 nameReady:false 并给出原因（不抛异常）", async () => {
		const { provider, org } = setup();
		org.self = { member_id: "" };
		const res = await makeSyncSelf(fakeHttp({}), provider, quietLog)(org);
		expect(res).toEqual({ nameReady: false, reason: expect.stringContaining("member_id") });
	});

	it("当 core 请求失败时，应 fail-open 返回 nameReady:false，并保留本地 owner", async () => {
		const { provider, org } = setup({ member_id: "local_owner", name: "Local" });
		const http: HttpForOrg = {
			apiPath: (path: string) => `/api/v1${path}`,
			getForOrg: async () => {
				throw new Error("network down");
			},
		};
		const res = await makeSyncSelf(http, provider, quietLog)(org);
		expect(res.nameReady).toBe(false);
		expect(org.owner).toEqual({ member_id: "local_owner", name: "Local" });
	});

	it("当 owner 名字首拉失败先存空名后，下一次 sync 应回填名字（不因 owner 未变而永久空名）", async () => {
		const { provider, org, reloadedOrg } = setup();
		// owner_1 暂不在册 → 首次绑定时名字拉取 404 失败（cosmetic，不阻塞绑定）。
		const members: Record<string, Record<string, unknown>> = {
			m_self: { display_name: "Codex", owner_member_id: "owner_1" },
		};
		const sync = makeSyncSelf(fakeHttp(members), provider, quietLog);

		// 第一次：owner 名字拉取失败 → 用空名绑定 owner。
		await sync(org);
		expect(org.owner).toEqual({ member_id: "owner_1", name: "" });

		// owner 名字随后可用（超时/短暂失败恢复）。
		members.owner_1 = { display_name: "Owner One" };

		// 第二次：owner 未变但本地名字为空 → 应继续回填，而非在「owner 未变」处提前返回把空名留下。
		await sync(org);
		expect(org.owner).toEqual({ member_id: "owner_1", name: "Owner One" });
		expect(reloadedOrg().owner).toEqual({ member_id: "owner_1", name: "Owner One" });
	});

	it("owner id 匹配且 core 仍无名字时，不做冗余写入（稳态不每 tick 重复 persist 空名）", async () => {
		const { provider, org } = setup({ member_id: "owner_1", name: "" });
		let setOwnerCalls = 0;
		const origSetOwner = provider.setOwner.bind(provider);
		provider.setOwner = ((...args: Parameters<typeof provider.setOwner>) => {
			setOwnerCalls++;
			return origSetOwner(...args);
		}) as typeof provider.setOwner;

		// owner_1 在册但无 display_name/username → 名字仍解析为空。
		const http = fakeHttp({
			m_self: { display_name: "Codex", owner_member_id: "owner_1" },
			owner_1: {},
		});
		const res = await makeSyncSelf(http, provider, quietLog)(org);

		// id 未变且名字仍为空 → 无变化 → 不调用 setOwner（不重复落盘空名）。
		expect(res.nameReady).toBe(true);
		expect(setOwnerCalls).toBe(0);
		expect(org.owner).toEqual({ member_id: "owner_1", name: "" });
	});
});

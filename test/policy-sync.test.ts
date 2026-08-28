// policy-sync: the pull-first reconcile between the local `access` block and cws-core.
//
// The load-bearing property is NEGATIVE — no PUT on an unknown or newer server state —
// so most cases assert on the recorded request list, not just on the returned outcome.
// The fake http throws on any path it does not recognise (same discipline as
// test/owner-sync.test.ts's fake): a reconcile that hits the wrong endpoint must fail
// the test rather than look like a successful no-op.
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type OrgAccess, type OrgConfig } from "../src/config.js";
import { buildConfigProvider } from "../src/runtime-config.js";
import {
	buildReportedPolicy,
	adoptServerPolicy,
	accessFingerprint,
	makeReconcilePolicy,
	startPeriodicOrgSync,
	type HttpPolicy,
	type ReportedPolicy,
	type ServerPolicySnapshot,
} from "../src/policy-sync.js";

// The real gate, not a stand-in: the point of the adopt-side assertions below is that a
// value decideInbound cannot read is a value that SKIPS a gate, so they are only meaningful
// when driven through the same function the runtime uses.
import { decideInbound } from "@openmaxai/openmax-agent-sdk";

const quietLog = { info() {}, warn() {}, error() {} };

const GROUP_CONV = { id: "c_x", type: "group" };
const groupMsg = (mentions: string[] = []) => ({
	conversation_id: "c_x",
	sender_id: "stranger",
	sender_type: "human",
	mentions,
	content: { body: { text: "plain chatter" } },
});
const gate = (access: OrgAccess, mentions: string[] = []) =>
	decideInbound(groupMsg(mentions), GROUP_CONV, { self: { member_id: "me", name: "oc" }, owner: { member_id: "own" }, access });

// access defaults mirror the real ex-codex config.json shape (same block as
// test/owner-sync.test.ts's baseConfig).
const DEFAULT_ACCESS: OrgAccess = { dmPolicy: "owner", dmAllowFrom: [], groupPolicy: "allowlist", groups: {} };

function baseConfig(access: OrgAccess) {
	return {
		enabled: true,
		server: { bff_url: "https://x", ws_url: "wss://x", frontend_base_path: "/workspace" },
		agent: { identity_id: "id_1", api_key: "cwsk_x", device_id: "dev_1", app_version: "codex-openmax/9.9.9" },
		orgs: {
			org_1: {
				enabled: true,
				org_id: "org_1",
				org_name: "Org One",
				owner: { member_id: "owner_1", name: "Owner One" },
				self: { member_id: "m_self", name: "Codex", display_name: "Codex" },
				access,
			},
		},
		codex: { bin: "codex", cwd: "/tmp" },
		bridge: { localHttpPort: 8787 },
	};
}

let currentPath = "";
function setup(access: OrgAccess = DEFAULT_ACCESS) {
	const dir = mkdtempSync(join(tmpdir(), "codex-policysync-"));
	const p = join(dir, "config.json");
	writeFileSync(p, JSON.stringify(baseConfig(access)));
	currentPath = p;
	const cfg = loadConfig(p);
	const provider = buildConfigProvider(cfg, p, quietLog);
	// Count every write path so a "steady state" case can prove zero persists
	// (test/owner-sync.test.ts uses the same wrap-and-count trick on setOwner).
	const writes = { updateConfig: 0, persist: 0 };
	const origUpdate = provider.updateConfig.bind(provider);
	provider.updateConfig = ((fn: Parameters<typeof provider.updateConfig>[0]) => {
		writes.updateConfig++;
		return origUpdate(fn);
	}) as typeof provider.updateConfig;
	const origPersist = provider.persist.bind(provider);
	provider.persist = (() => {
		writes.persist++;
		return origPersist();
	}) as typeof provider.persist;
	return { p, provider, writes, org: provider.enabledOrgs()[0], reloadedOrg: (): OrgConfig => loadConfig(p).orgs[0] };
}
afterEach(() => {
	if (currentPath) rmSync(currentPath, { force: true });
	currentPath = "";
});

const POLICY_PATH = "/api/v1/agents/m_self/policy";
const REPORT_PATH = "/api/v1/agents/m_self/reported-policy";

interface PutRecord {
	path: string;
	body: ReportedPolicy;
}
/** Recording http fake. `get` throws to simulate a read failure; `onPut` may throw to
 * simulate a server rejection. Any unexpected path throws. */
function fakeHttp(opts: { get?: () => ServerPolicySnapshot; onPut?: (body: ReportedPolicy, attempt: number) => void }) {
	const gets: string[] = [];
	const puts: PutRecord[] = [];
	const http: HttpPolicy = {
		apiPath: (path: string) => `/api/v1${path}`,
		getForOrg: async (_orgId: string, path: string) => {
			if (path !== POLICY_PATH) throw new Error(`unexpected GET ${path}`);
			gets.push(path);
			if (!opts.get) throw new Error("policy read not stubbed");
			return opts.get();
		},
		putForOrg: async (_orgId: string, path: string, body: unknown) => {
			if (path !== REPORT_PATH) throw new Error(`unexpected PUT ${path}`);
			puts.push({ path, body: body as ReportedPolicy });
			opts.onPut?.(body as ReportedPolicy, puts.length);
			return {};
		},
	};
	return { http, gets, puts };
}

function httpError(status: number, message: string): Error & { status: number; body: unknown } {
	const err = new Error(message) as Error & { status: number; body: unknown };
	err.status = status;
	err.body = { error: { status, detail: message } };
	return err;
}

describe("buildReportedPolicy — 哨兵与服务端 enum", () => {
	it("空 access 的每个默认值都必须与 SDK decideInbound 的兜底逐字一致，且 group_scope 显式发送", () => {
		expect(buildReportedPolicy({})).toEqual({
			dm_policy: "owner",
			dm_allowlist: [],
			groups: [],
			// 必须显式：cws-core 的 report-policy 把缺省 group_scope 强制成 "open"（agent_policy.go），
			// 与 SDK 本地的 'allowlist' 兜底正好相反 —— 漏发等于把自己开成全群可进。
			group_scope: "allowlist",
			group_allowlist: [],
		});
		expect(buildReportedPolicy().group_scope).toBe("allowlist");
	});

	it("mode:'silent' 必须同时从 groups[] 和 group_allowlist 剔除（服务端 enum 只接 smart/mention，一条就 400 整份）", () => {
		const body = buildReportedPolicy({
			groupPolicy: "allowlist",
			groups: {
				c_live: { mode: "smart", allowFrom: ["u1"] },
				c_quiet: { mode: "silent", allowFrom: ["*"] },
			},
		});
		expect(body.groups.map((g) => g.conversation_id)).toEqual(["c_live"]);
		expect(body.group_allowlist).toEqual(["c_live"]);
	});

	it("allowFrom 的 undefined / [] / 含 '*' 三种全放行写法都归一成 ['*']（[] 在 JS 是真值，`|| ['*']` 得不到它）", () => {
		const body = buildReportedPolicy({
			groups: {
				c_empty: { mode: "mention", allowFrom: [] },
				c_missing: { mode: "mention" },
				c_star: { mode: "mention", allowFrom: ["*"] },
			},
		});
		expect(body.groups.map((g) => g.allow_from)).toEqual([["*"], ["*"], ["*"]]);
	});

	it("owner 绝不被塞进 dm_allowlist（DM 的 owner 豁免服务端表达不了，混进去会变成一条真实的成员授权）", () => {
		expect(buildReportedPolicy({ dmPolicy: "allowlist", dmAllowFrom: ["u1"] }).dm_allowlist).toEqual(["u1"]);
	});
});

describe("adoptServerPolicy — 拉取方向", () => {
	it("只在 group_allowlist 里、还没有 groups 行的群，必须并进本地 groups（否则设置页显示允许而 agent 拒绝）", () => {
		const access = adoptServerPolicy({
			dm_policy: "open",
			dm_allowlist: ["u9"],
			group_scope: "allowlist",
			groups: [{ conversation_id: "c1", mode: "smart", allow_from: ["u1"] }],
			group_allowlist: ["c1", "c2"],
			updated_at: 1000,
		});
		expect(access).toEqual({
			dmPolicy: "open",
			dmAllowFrom: ["u9"],
			groupPolicy: "allowlist",
			groups: { c1: { mode: "smart", allowFrom: ["u1"] }, c2: { mode: "mention", allowFrom: ["*"] } },
		});
	});

	it("响应缺 group_scope 时退回 'allowlist' 而非服务端自己的 'open' 默认（畸形响应不许放宽群暴露面）", () => {
		expect(adoptServerPolicy({}).groupPolicy).toBe("allowlist");
		expect(adoptServerPolicy(null).dmPolicy).toBe("owner");
	});

	it("越界的 group_scope 不许原样落地——decideInbound 只认 disabled/allowlist，别的字符串会整个跳过白名单闸", async () => {
		const local: OrgAccess = { dmPolicy: "owner", dmAllowFrom: [], groupPolicy: "allowlist", groups: {} };
		const adopted = adoptServerPolicy({ group_scope: "members", groups: [], group_allowlist: [], updated_at: 1 }, local);
		expect(adopted.groupPolicy).toBe("allowlist");
		expect((await gate(adopted, ["me"])).handle).toBe(false);
		// 对照：不校验时那个字符串会直接进 access，闸失效。
		expect((await gate({ ...local, groupPolicy: "members" }, ["me"])).handle).toBe(true);
	});

	it("越界的 per-group mode 不许原样落地——decideInbound 只特判 mention，别的字符串会绕过 @ 要求", async () => {
		const local: OrgAccess = { dmPolicy: "owner", dmAllowFrom: [], groupPolicy: "allowlist", groups: { c_x: { mode: "mention", allowFrom: ["*"] } } };
		const adopted = adoptServerPolicy(
			{ group_scope: "allowlist", groups: [{ conversation_id: "c_x", mode: "quiet", allow_from: ["*"] }], group_allowlist: ["c_x"], updated_at: 1 },
			local,
		);
		expect(adopted.groups?.c_x?.mode).toBe("mention");
		expect((await gate(adopted)).handle).toBe(false);
		// 对照：mode 原样落地时，没被 @ 的消息也会被处理。
		expect((await gate({ ...local, groups: { c_x: { mode: "quiet", allowFrom: ["*"] } } })).handle).toBe(true);
	});

	it("allowlist 模式下,owner 刚移除的群不许被存活的逐群行复活（cws-comm 的 remove 只改 allowlist、不删行）", async () => {
		const adopted = adoptServerPolicy({
			group_scope: "allowlist",
			groups: [{ conversation_id: "c_x", mode: "mention", allow_from: ["*"] }],
			group_allowlist: [],
			updated_at: 1,
		});
		expect(adopted.groups).toEqual({});
		expect((await gate(adopted, ["me"])).handle).toBe(false);
	});

	it("open/disabled 模式下 allowlist 不是闸,仍应取并集以保住逐群 mode", () => {
		const adopted = adoptServerPolicy({
			group_scope: "open",
			groups: [{ conversation_id: "c_x", mode: "smart", allow_from: ["*"] }],
			group_allowlist: ["c_y"],
			updated_at: 1,
		});
		expect(adopted.groupPolicy).toBe("open");
		expect(Object.keys(adopted.groups || {}).sort()).toEqual(["c_x", "c_y"]);
		expect(adopted.groups?.c_x?.mode).toBe("smart");
	});
});

describe("makeReconcilePolicy — updated_at 的两种线上格式", () => {
	it("RFC3339 形式的 updated_at 不许被读成 0——否则一个全默认的策略行会被当成「无行」,每个 tick 都无条件 PUT", async () => {
		const { provider, org } = setup();
		// 真实可达的状态：owner 只改过 DM 策略,于是行存在但几个数组都是空的。
		const { http, puts } = fakeHttp({
			get: () => ({ dm_policy: "open", dm_allowlist: [], group_scope: "open", groups: [], group_allowlist: [], updated_at: "2026-08-28T06:51:45Z" }),
		});
		const reconcile = makeReconcilePolicy(http, provider, quietLog);
		expect(await reconcile(org)).toBe("adopted");
		expect(puts).toEqual([]);
	});
});

describe("makeReconcilePolicy — 播种", () => {
	it("当 updated_at 缺失且快照为空（服务端无策略行）时，应恰好 PUT 一次，且 body 精确", async () => {
		const { provider, org } = setup({ dmPolicy: "owner", dmAllowFrom: ["u1"], groupPolicy: "allowlist", groups: { c1: { mode: "smart", allowFrom: [] } } });
		const { http, gets, puts } = fakeHttp({ get: () => ({ dm_policy: "owner", group_scope: "open", groups: [], group_allowlist: [] }) });
		const outcome = await makeReconcilePolicy(http, provider, quietLog)(org);
		expect(outcome).toBe("seeded");
		expect(gets).toEqual([POLICY_PATH]); // 读在写之前
		expect(puts).toEqual([
			{
				path: REPORT_PATH,
				body: {
					dm_policy: "owner",
					dm_allowlist: ["u1"],
					groups: [{ conversation_id: "c1", mode: "smart", allow_from: ["*"] }],
					group_scope: "allowlist",
					group_allowlist: ["c1"],
				},
			},
		]);
	});

	it("当 updated_at 缺失但快照已有 groups 时，不得 PUT（那不是空行，写进去就是擦除）", async () => {
		const { provider, org } = setup();
		const { http, puts } = fakeHttp({
			get: () => ({ dm_policy: "open", group_scope: "allowlist", groups: [{ conversation_id: "c1", mode: "smart", allow_from: ["*"] }], group_allowlist: ["c1"] }),
		});
		const outcome = await makeReconcilePolicy(http, provider, quietLog)(org);
		expect(outcome).toBe("adopted");
		expect(puts).toEqual([]);
	});
});

describe("makeReconcilePolicy — 服务端权威 / 本地权威 / 稳态", () => {
	it("当 updated_at>0 且与 marker 不同时，应零 PUT，并把服务端策略采纳落盘", async () => {
		const { provider, org, writes, reloadedOrg } = setup();
		const { http, puts } = fakeHttp({
			get: () => ({
				dm_policy: "allowlist",
				dm_allowlist: ["u7"],
				group_scope: "allowlist",
				groups: [{ conversation_id: "c1", mode: "mention", allow_from: ["*"] }],
				group_allowlist: ["c1"],
				updated_at: 1700000000000,
			}),
		});
		const outcome = await makeReconcilePolicy(http, provider, quietLog)(org);
		expect(outcome).toBe("adopted");
		expect(puts).toEqual([]);
		// 落到 SDK 的 live orgConfig + 磁盘两侧
		expect(org.access).toEqual({ dmPolicy: "allowlist", dmAllowFrom: ["u7"], groupPolicy: "allowlist", groups: { c1: { mode: "mention", allowFrom: ["*"] } } });
		expect(reloadedOrg().access).toEqual(org.access);
		expect(writes.updateConfig).toBe(1);
	});

	it("当服务端自 marker 以来未变、而本地指纹变了时，应 PUT 推送本地", async () => {
		const { provider, org } = setup();
		const snapshot: ServerPolicySnapshot = {
			dm_policy: "owner",
			dm_allowlist: [],
			group_scope: "allowlist",
			groups: [{ conversation_id: "c1", mode: "mention", allow_from: ["*"] }],
			group_allowlist: ["c1"],
			updated_at: 1700000000000,
		};
		const { http, puts } = fakeHttp({ get: () => snapshot });
		const reconcile = makeReconcilePolicy(http, provider, quietLog);
		expect(await reconcile(org)).toBe("adopted"); // 第一轮建立 marker
		expect(puts).toEqual([]);

		// 本地随后改了（在真实运行里来自手动编辑 + report-policy，或本地 access 的其它写入方）。
		org.access.dmPolicy = "open";
		expect(await reconcile(org)).toBe("pushed");
		expect(puts).toHaveLength(1);
		expect(puts[0].body.dm_policy).toBe("open");
		expect(puts[0].body.group_allowlist).toEqual(["c1"]);
	});

	it("双方一致时应零 PUT、零落盘（稳态不许每 tick 写一次磁盘）", async () => {
		const { provider, org, writes } = setup();
		const snapshot: ServerPolicySnapshot = {
			dm_policy: "owner",
			dm_allowlist: [],
			group_scope: "allowlist",
			groups: [],
			group_allowlist: [],
			updated_at: 1700000000000,
		};
		const { http, puts } = fakeHttp({ get: () => snapshot });
		const reconcile = makeReconcilePolicy(http, provider, quietLog);
		expect(await reconcile(org)).toBe("adopted");
		const writesAfterFirst = { ...writes };
		expect(await reconcile(org)).toBe("noop");
		expect(await reconcile(org)).toBe("noop");
		expect(puts).toEqual([]);
		expect(writes).toEqual(writesAfterFirst);
	});

	it("KILLING: GET 失败时必须零 PUT（服务端状态未知，写进去就是拿本地默认值覆盖）", async () => {
		const { provider, org, writes } = setup();
		const { http, puts } = fakeHttp({}); // get 未打桩 → 抛
		const outcome = await makeReconcilePolicy(http, provider, quietLog)(org);
		expect(outcome).toBe("skipped:get-failed");
		expect(puts).toEqual([]);
		expect(writes).toEqual({ updateConfig: 0, persist: 0 });
	});

	it("当 self.member_id 还没写回时应跳过，且不发任何请求", async () => {
		const { provider, org } = setup();
		org.self = { member_id: "" };
		const { http, gets, puts } = fakeHttp({ get: () => ({}) });
		expect(await makeReconcilePolicy(http, provider, quietLog)(org)).toBe("skipped:no-member-id");
		expect(gets).toEqual([]);
		expect(puts).toEqual([]);
	});

	it("http 客户端没有 putForOrg 时应能力探测跳过（不抛）", async () => {
		const { provider, org } = setup();
		const http = { apiPath: (p: string) => `/api/v1${p}`, getForOrg: async () => ({}) } as unknown as HttpPolicy;
		expect(await makeReconcilePolicy(http, provider, quietLog)(org)).toBe("skipped:unsupported-http");
	});
});

describe("makeReconcilePolicy — 404 的两种含义", () => {
	it("4xx 指名某个已退出的群时，剔除该群重试一次（不得当成端点不存在然后永久静默）", async () => {
		const { provider, org } = setup({ dmPolicy: "owner", dmAllowFrom: [], groupPolicy: "allowlist", groups: { c_live: { mode: "mention", allowFrom: ["*"] }, c_dead: { mode: "mention", allowFrom: ["*"] } } });
		const { http, puts } = fakeHttp({
			get: () => ({ dm_policy: "owner", group_scope: "open", groups: [], group_allowlist: [] }),
			onPut: (_body, attempt) => {
				// cws-comm 的 verifyAgentGroupMember 失败会被包成 `group <id>: ...` 并映射成 404。
				if (attempt === 1) throw httpError(404, "group c_dead: get member: not found");
			},
		});
		// 走的是播种路径（服务端还没有行），所以成功码是 seeded；关键断言是「重试了一次、且只剔掉那一个群」。
		expect(await makeReconcilePolicy(http, provider, quietLog)(org)).toBe("seeded");
		expect(puts).toHaveLength(2);
		expect(puts[1].body.groups.map((g) => g.conversation_id)).toEqual(["c_live"]);
		expect(puts[1].body.group_allowlist).toEqual(["c_live"]);
	});

	it("404 未指名任何本次上报的群时，视为端点不存在：不重试", async () => {
		const { provider, org } = setup({ ...DEFAULT_ACCESS, groups: { c_live: { mode: "mention", allowFrom: ["*"] } } });
		const { http, puts } = fakeHttp({
			get: () => ({ dm_policy: "owner", group_scope: "open", groups: [], group_allowlist: [] }),
			onPut: () => {
				throw httpError(404, "404 page not found");
			},
		});
		expect(await makeReconcilePolicy(http, provider, quietLog)(org)).toBe("push-failed");
		expect(puts).toHaveLength(1);
	});
});

describe("accessFingerprint", () => {
	it("对同一份策略与键序无关，且只跟随可上报的差异变化", () => {
		expect(accessFingerprint({ groups: { a: { mode: "mention" }, b: { mode: "smart" } } })).toBe(
			accessFingerprint({ groups: { b: { mode: "smart" }, a: { mode: "mention" } } }),
		);
		expect(accessFingerprint({ dmPolicy: "owner" })).not.toBe(accessFingerprint({ dmPolicy: "open" }));
		// 只上报不了的差异（silent 群）不改变指纹 → 不会引出一次无内容变化的 PUT。
		expect(accessFingerprint({ groups: {} })).toBe(accessFingerprint({ groups: { z: { mode: "silent" } } }));
	});
});

describe("startPeriodicOrgSync — 接线本身要有守卫", () => {
	it("周期 tick 必须对每个启用的 org 依次跑 owner-sync 和 policy reconcile", async () => {
		const orgs = [{ org_id: "org_1" }, { org_id: "org_2" }] as OrgConfig[];
		const calls: string[] = [];
		let scheduledMs = 0;
		let tick: (() => void | Promise<void>) | undefined;
		let disposed = false;
		const dispose = startPeriodicOrgSync(5 * 60 * 1000, {
			enabledOrgs: () => orgs,
			syncSelf: async (o) => void calls.push(`sync:${o.org_id}`),
			reconcilePolicy: async (o) => void calls.push(`reconcile:${o.org_id}`),
			schedule: (ms, fn) => {
				scheduledMs = ms;
				tick = fn;
				return () => {
					disposed = true;
				};
			},
		});
		expect(scheduledMs).toBe(5 * 60 * 1000);
		await tick!();
		expect(calls).toEqual(["sync:org_1", "reconcile:org_1", "sync:org_2", "reconcile:org_2"]);
		dispose();
		expect(disposed).toBe(true);
	});
});

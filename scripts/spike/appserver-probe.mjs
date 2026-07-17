// P0 spike probe: drive `codex app-server` over stdio JSON-RPC (JSONL framing).
// Sequence: initialize -> thread/start -> turn/start -> (observe) -> thread/inject_items -> turn/steer (bad turn id)
// Goal: validate injection mechanics + error surfaces WITHOUT auth (model call expected to fail).
import { spawn } from "node:child_process";

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
let id = 0;
const pending = new Map();
const log = (dir, obj) => console.log(dir, JSON.stringify(obj).slice(0, 600));

function send(method, params) {
  const req = { jsonrpc: "2.0", id: ++id, method, params };
  log("->", req);
  child.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((res) => pending.set(req.id, res));
}

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { console.log("<- (unparsed)", line.slice(0, 200)); continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      log("<- resp", msg);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    } else if (msg.method && msg.id !== undefined) {
      log("<- SERVER REQ", msg); // server->client request (approvals etc.)
    } else {
      log("<- notif", msg);
    }
  }
});
child.stderr.on("data", (d) => console.log("[stderr]", d.toString().trim().slice(0, 400)));
child.on("exit", (c) => console.log("[exit]", c));

const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

const init = await send("initialize", { clientInfo: { name: "codex-openmax-spike", version: "0.0.1" } });
// Some protocols require an initialized notification:
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");

const th = await send("thread/start", { cwd: process.cwd(), ephemeral: true });
const threadId = th.result?.thread?.id ?? th.result?.threadId ?? th.result?.id;
console.log("### threadId =", threadId);

if (threadId) {
  // 1) no-turn injection via turn/start (expected: auth error at model call, but mechanics visible)
  const t1 = await send("turn/start", { threadId, input: [{ type: "text", text: "Reply with exactly: PONG" }] });
  await timeout(4000);

  // 2) thread/inject_items without an active turn (local history append — may work without auth)
  const inj = await send("thread/inject_items", {
    threadId,
    items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "[injected context] hello" }] }],
  });

  // 3) turn/steer with a bogus expectedTurnId (validate CAS failure surface)
  const st = await send("turn/steer", { threadId, expectedTurnId: "turn_nonexistent", input: [{ type: "text", text: "steer probe" }] });

  // 4) read back thread to see model-visible history
  const rd = await send("thread/read", { threadId });
}

await timeout(2000);
child.kill();

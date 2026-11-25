/**
 * 重连退避曲线验证（不依赖真实 WebSocket，纯逻辑仿真）
 *
 * 验三件事：
 *   1. 从没连上过（冷）时，间隔是否 1→2→4→5→5…（5s 封顶）
 *   2. 连上过一次（热）之后，上限是否收紧到 3s（服务就在本机，断线基本只意味着它在重启）
 *   3. 已有一条健康连接时，connect(false) 会不会把它拆掉
 * 第 1 条直接决定服务端没启动时 chrome 控制台被刷多少条红字。
 *
 * 用法（在 browser-bridge 目录下）：
 *     node tools/retry_backoff_test.mjs
 * 注意：.mjs 后缀是必须的 —— ws-client.js 是 ESM。
 */
import { Bridge } from '../extension/src/sw/ws-client.js';

const delays = [];
let timerId = 0;

globalThis.setTimeout = (fn, ms) => {
  delays.push(ms);
  return ++timerId;
};
globalThis.clearTimeout = () => {};

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor() {
    this.readyState = 0;
    // 立刻"被拒"，模拟 ERR_CONNECTION_REFUSED
    queueMicrotask(() => {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1006 });
    });
  }
  send() {}
  close() {}
}
globalThis.WebSocket = FakeWS;

globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
  runtime: { getManifest: () => ({ version: '1.0.0' }) }
};

const b = new Bridge();
await b.ensure();

const tick = () => new Promise((r) => setTimeout0(r));
const setTimeout0 = (r) => Promise.resolve().then(r).then(r).then(r);

const cold = [];
for (let i = 0; i < 9; i++) {
  b.retryTimer = null; // 模拟定时器到点后清空，然后手动再连一次
  b.connect(false);
  await new Promise((r) => Promise.resolve().then(() => Promise.resolve().then(r)));
}
// 注意 delays[0]（1000ms）是 ensure() 那次产生的，也在序列里，别漏掉
cold.push(...delays.slice(0, 9));

console.log('冷启动重连间隔(ms):', cold.join(', '));
console.log('  → 期望 1000,2000,4000,5000,5000,5000,...（5s 封顶）');

// 模拟"连上过一次"
delays.length = 0;
b.everConnected = true;
b.retry = 0;
const warm = [];
for (let i = 0; i < 7; i++) {
  const before = delays.length;
  b.retryTimer = null;
  b.connect(false);
  await new Promise((r) => Promise.resolve().then(() => Promise.resolve().then(r)));
  if (delays.length > before) warm.push(delays[delays.length - 1]);
}console.log('热启动重连间隔(ms):', warm.join(', '));
console.log('  → 期望 1000,2000,3000,3000,3000,...（3s 封顶）');

// 校验：健康连接不被拆掉
const healthy = new Bridge();
await healthy.ensure();
healthy.ws = { readyState: 1 }; // 假装一条 OPEN 的连接
const before = healthy.ws;
healthy.connect(false);
console.log('\n健康连接是否被保留:', healthy.ws === before ? '是（正确）' : '否（错误：被拆了）');

const coldOk = JSON.stringify(cold.slice(0, 6)) === JSON.stringify([1000, 2000, 4000, 5000, 5000, 5000]);
const warmOk = JSON.stringify(warm.slice(0, 5)) === JSON.stringify([1000, 2000, 3000, 3000, 3000]);
const keepOk = healthy.ws === before;
console.log('\n结果:', coldOk && warmOk && keepOk ? '全部符合预期' : '有偏差，见上');
process.exit(coldOk && warmOk && keepOk ? 0 : 1);

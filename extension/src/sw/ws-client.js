/**
 * Browser Bridge · service worker 的 WebSocket 客户端
 *
 * 【为什么 SW 里的 WebSocket 需要"三保险"保活？】
 *   MV3 的 service worker 空闲约 30 秒会被浏览器强制回收，连接随之断开。
 *   最坏情况：agent 发指令时连接刚好是断的 → 指令石沉大海。
 *   所以这里做了三层：
 *     1. 断线立即指数退避重连（1s → 2s → 4s … 上限 15s）；
 *     2. 任何外部事件（alarm / 面板操作 / content 探针）都会触发 ensure()，等于"随手捡一遍"；
 *     3. 服务端每 20 秒发心跳，处理消息会重置 SW 空闲计时器 —— 只要本地服务开着，SW 基本不睡。
 *
 * 【为什么不做离线指令队列？】
 *   浏览器自动化是"人此刻在看着"的场景：连接断了还排队重放，会在一分钟后突然
 *   在页面上乱点一气，比直接失败危险得多。断连就直接失败，让 agent 知道。
 */

const DEFAULTS = {
  url: 'ws://127.0.0.1:8765',
  token: '',
  /** 单条指令在插件侧的兜底超时，避免卡死的页面把链路堵住 */
  callTimeoutMs: 30000,
  /** 重连起始间隔 */
  retryBaseMs: 1000,
  /**
   * 「连上过之后又断了」的重连间隔上限。
   *
   * 这个值必须小：连上过就说明服务确实存在于本机，断线几乎只有一种原因 ——
   * 服务正在重启（比如 WorkBuddy 重启时把 MCP 服务拉起来）。
   * 这种情况下 15 秒才追一次，用户看到的就是"插件怎么还没连上"。
   * 3 秒反正在回环地址上几乎不产生任何代价，却能把它压到"重启完基本就接上了"。
   */
  retryMaxMs: 3000,
  /**
   * 「从没连上过」时的重连间隔上限。
   *
   * 为什么要单独设这一档：连接被拒时，Chrome 会自己往控制台打一条红色
   * `WebSocket connection to 'ws://127.0.0.1:8765/' failed: net::ERR_CONNECTION_REFUSED`。
   * 这条日志由浏览器产生，JS 侧无法屏蔽、无法接管 —— 想不刷屏，只能少试。
   *
   * 但也不能太长。原先是 30 秒，实测的代价是：本机服务（由 WorkBuddy 拉起）
   * 起来之后，插件最坏要干等 30 秒才接上，用户感知就是"插件连本地服务很慢"。
   * 现在压到 5 秒，最坏 5 秒内接上 —— 而那条红字只出现在**扩展自身 SW 的控制台**
   * （chrome://extensions → Service Worker → 检查视图），不是页面控制台，
   * 平时根本不会有人看到，为此牺牲连接体验不值当。
   */
  retryMaxMsCold: 5000
};

export class Bridge {
  constructor() {
    this.ws = null;
    this.url = DEFAULTS.url;
    this.token = '';
    this.state = 'idle'; // idle | connecting | open | closed
    this.retry = 0;
    this.retryTimer = null;
    this.helloTimer = null;
    this.lastError = '';
    /** 是否成功连上过至少一次。决定重试用「热」还是「冷」的上限，也用于给用户提示。 */
    this.everConnected = false;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.seq = 0;
    this.commandHandler = null;
    this.statusHandler = null;
    this.flushHandler = null;
    this.flushTimer = null;
    /** 配置来源：managed（企业策略下发）｜ local（用户手填）｜ default */
    this.source = 'default';
    /**
     * 是否被企业策略锁定。
     *
     * IT 通过 Chrome 策略下发 wsUrl/wsToken 后，这个开关为 true —— 此时
     * 弹窗里的输入框应当只读，因为改也改不动（managed 优先级高于 local，
     * 用户手填会被下次重连时覆盖掉，让人莫名其妙）。
     */
    this.managedLocked = false;
    this.ready = this.loadConfig();
  }

  /**
   * 读连接配置。**优先级：企业策略 > 本地手填 > 内置默认**。
   *
   * 为什么要读企业策略（chrome.storage.managed）：
   *   批量给同事装的时候，「服务地址 + token」靠嘴传、靠文档贴，既麻烦又容易泄。
   *   IT 在域策略里一次性下发，用户装完扩展就是连好的 —— 零配置，且用户改不掉。
   *   没配策略时（自己用的场景），managed 里是空的，自动退回原有的本地配置逻辑，
   *   所以这个改动对单机用户是完全透明的。
   *
   * 注意：`chrome.storage.managed.get()` 在没有策略的机器上**可能抛错**
   * （不同 Chrome 版本行为不一致），所以这里必须 try/catch，绝不能让它中断启动。
   */
  async loadConfig() {
    // ── 第一优先：企业策略 ──
    try {
      const managed = await chrome.storage.managed.get(['wsUrl', 'wsToken']);
      if (managed && managed.wsUrl) {
        this.url = managed.wsUrl;
        this.token = managed.wsToken || '';
        this.source = 'managed';
        this.managedLocked = true;
        return;
      }
    } catch (e) {
      /* 没有配策略，属于正常情况，安静退回本地配置 */
    }

    // ── 第二优先：本地手填 ──
    try {
      const cfg = await chrome.storage.local.get(['wsUrl', 'wsToken']);
      if (cfg.wsUrl) this.url = cfg.wsUrl;
      if (cfg.wsToken != null) this.token = cfg.wsToken;
      this.source = cfg.wsUrl ? 'local' : 'default';
    } catch (e) {
      /* 首次安装时 storage 为空，用默认值即可 */
    }
  }

  onStatus(fn) {
    this.statusHandler = fn;
  }

  onCommand(fn) {
    this.commandHandler = fn;
  }

  onFlush(fn) {
    this.flushHandler = fn;
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.flushHandler) this.flushHandler();
    }, 400);
  }

  flushNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushHandler) this.flushHandler();
  }

  snapshot() {
    return {
      connected: this.state === 'open',
      state: this.state,
      url: this.url,
      reason: this.lastError || null,
      everConnected: this.everConnected,
      retry: this.retry,
      /** 配置来源：managed（企业策略）｜ local（手填）｜ default（内置默认） */
      source: this.source,
      /** 为 true 时，弹窗里的地址/token 输入框应只读 */
      managedLocked: this.managedLocked
    };
  }

  /**
   * 运行期改服务地址 / token，改完立刻重连（弹窗保存配置时用）。
   *
   * 被企业策略锁定时**直接拒绝**，返回 {rejected:true,...}。
   * 为什么要拒绝而不是"改完本次生效"：managed 的优先级高于 local，
   * 用户填的值在下次 loadConfig 时会被策略值覆盖 —— 当场生效、重启变回去，
   * 这种"看起来成功"的行为比明确报错难排查得多。
   */
  async reconfigure(url, token) {
    await this.ready;

    if (this.managedLocked) {
      return {
        rejected: true,
        reason:
          '服务地址与 token 由企业策略统一配置，此处无法修改。' +
          '如需调整，请联系 IT 修改下发给本扩展的策略。'
      };
    }

    if (url) this.url = url;
    if (token !== undefined) this.token = token;
    try {
      await chrome.storage.local.set({ wsUrl: this.url, wsToken: this.token });
      this.source = 'local';
    } catch (e) {
      /* 写不进去也不影响本次生效 */
    }
    await this.reconnect();
    return null;
  }

  /** 主动重连（不改配置）。用户嫌"怎么还没连上"时，弹窗上那个按钮就是干这个的。 */
  async reconnect() {
    await this.ready;
    this.retry = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardown('手动重连');
    return this.connect(true);
  }

  emitStatus() {
    if (this.statusHandler) {
      try {
        this.statusHandler(this.snapshot());
      } catch (e) {
        /* 状态回调本身出错不能影响连接 */
      }
    }
  }

  /** 幂等：已连/正在连则直接返回；否则发起连接。所有入口都该调它。 */
  async ensure() {
    await this.ready;
    if (this.state === 'open' || this.state === 'connecting') {
      // 连接看着是好的，但可能已经是"僵尸"（对端悄悄关了而没触发 close）
      if (this.state === 'open' && this.ws && this.ws.readyState !== WebSocket.OPEN) {
        this.teardown('连接已失效，重建中');
        return this.connect();
      }
      return;
    }
    return this.connect();
  }

  /**
   * 把 token 拼进 URL。
   * 走 query 而不是 hello 消息，是为了让服务端在**握手阶段**就能拒掉未授权的连接 ——
   * 不需要先建立连接再判身份，少一个被利用的窗口。
   */
  buildUrl() {
    if (!this.token) return this.url;
    const sep = this.url.indexOf('?') === -1 ? '?' : '&';
    return this.url + sep + 'token=' + encodeURIComponent(this.token);
  }

  /**
   * 建立连接。
   *
   * force=false（默认，所有自动路径都走这条）：如果已有一条 CONNECTING / OPEN 的
   *   连接，**原样保留**。这是必须的 —— 旧实现无条件 `teardown + 新建`，而
   *   ensure() 会被 alarm、content 探针、面板点击等多个来源并发触发，
   *   于是出现「刚连上 0.6 秒就被自己拆掉、隔 2 毫秒再连一次」的抖动，
   *   中间那段空窗里下发的 agent 指令会平白失败（日志里实见过）。
   * force=true：只给 reconnect() 用，用户明确要求重建。
   */
  connect(force) {
    if (this.ws) {
      const rs = this.ws.readyState;
      if (!force && (rs === WebSocket.CONNECTING || rs === WebSocket.OPEN)) return;
      this.teardown(force ? '强制重建' : '旧连接已失效');
    }

    this.state = 'connecting';
    this.emitStatus();

    let ws;
    try {
      ws = new WebSocket(this.buildUrl());
    } catch (e) {
      this.lastError = '地址非法：' + String((e && e.message) || e);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.state = 'open';
      this.everConnected = true;
      this.retry = 0;
      this.lastError = '';
      this.emitStatus();
      this.sendRaw({
        type: 'hello',
        role: 'extension',
        version: chrome.runtime.getManifest().version,
        token: this.token,
        agent: navigator.userAgent
      });
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onerror = () => {
      // onerror 的 Event 里没有可用信息，真实原因在 onclose 里
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // 已被新连接替换，忽略旧连接的回调
      this.state = 'closed';
      this.lastError = ev && ev.code ? '连接关闭 code=' + ev.code : '连接已断开';
      this.failAllPending(this.lastError);
      this.emitStatus();
      this.scheduleRetry();
    };
  }

  scheduleRetry() {
    if (this.retryTimer) return;
    // 从没连上过 → 用「冷」上限，把浏览器自带的 ERR_CONNECTION_REFUSED 刷屏降到最低
    const cap = this.everConnected ? DEFAULTS.retryMaxMs : DEFAULTS.retryMaxMsCold;
    const delay = Math.min(cap, DEFAULTS.retryBaseMs * Math.pow(2, this.retry));
    // retry 本身要给个上限，否则翻到 2^1024 就是 Infinity（虽然 Math.min 能兜住，但没必要留着）
    this.retry = Math.min(this.retry + 1, 12);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect(false);
    }, delay);
  }

  teardown(reason) {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
      } catch (e) {
        /* 忽略 */
      }
    }
    this.lastError = reason || '';
    this.failAllPending(reason || '连接已重建');
  }

  failAllPending(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // 心跳：服务端每 20 秒来一次，回 pong 顺带续 SW 的命
    if (msg.type === 'ping') {
      this.sendRaw({ type: 'pong', t: Date.now() });
      return;
    }

    if (msg.type === 'pong') return;

    if (msg.type === 'welcome') {
      this.lastError = msg.note || '';
      this.emitStatus();
      return;
    }

    if (msg.type === 'error') {
      this.lastError = msg.message || '服务端返回错误';
      this.emitStatus();
      return;
    }

    // 指令下发
    if (msg.id != null && msg.cmd) {
      if (!this.commandHandler) {
        this.sendRaw({ id: msg.id, ok: false, error: '插件尚未就绪' });
        return;
      }
      Promise.resolve()
        .then(() => this.commandHandler(msg))
        .then((res) => this.sendRaw(res))
        .catch((e) =>
          this.sendRaw({
            id: msg.id,
            ok: false,
            error: String((e && e.message) || e)
          })
        );
      return;
    }

    // 指令回执
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  /** 发一条原始消息；连接不可用时静默丢弃（心跳丢了无所谓） */
  sendRaw(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 主动向本地服务发一条指令并等回执。
   * 主要用于插件自身发起的调用（如 popup 里的连通性自测）。
   */
  async call(cmd, args, timeoutMs) {
    await this.ready;
    if (this.state !== 'open') {
      throw new Error('未连接到本地服务（' + this.url + '）：' + (this.lastError || '尚未建立连接'));
    }
    const id = 'ext-' + Date.now() + '-' + ++this.seq;
    const timeout = timeoutMs || DEFAULTS.callTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('等待服务端回执超时（' + timeout + 'ms）'));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      const ok = this.sendRaw({ id: id, cmd: cmd, args: args || {} });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('发送失败：连接不可用'));
      }
    });
  }
}

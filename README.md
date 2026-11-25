# Browser Bridge · 让 agent 操控你已登录的 Chrome

**这是给 agent 用的工具，不是给终端用户用的工具。**
终端用户和这个扩展之间**没有"点这个按钮完成某某事"的直接交互**——所有能力都由 agent 通过 MCP 调用驱动。

日常使用的工作流是这样的：

```
用户：  "帮我每天早上去生意参谋把昨天的销售数据抓下来"
   ↓
agent： browser_activate_tab 切到生意参谋
        browser_find / browser_ax 定位要点的按钮
        browser_click 触发 → 拿接口 → 解析 → 整理成 xlsx
   ↓
用户：  收到一份可重复运行的脚本，明天直接 agent 自动跑
```

下次生意参谋改版，agent 重跑一遍 + 自动定位修复——**人不需要再来一次**。

> 定位：影刀浏览器插件的能力替代品，但操控方从「影刀客户端 GUI」换成了「你自己的 agent」。

---

## agent 的工作流是什么样

举个具体例子：抓"生意参谋昨天的店铺月报"。

```
用户（自然语言）:  帮我把生意参谋昨天那天的店铺月报抓下来，存成 xlsx
   ↓
agent 第 1 轮：   browser_status     → 看服务通不通
                  browser_tabs        → 拿 tabId
                  browser_activate_tab → 把生意参谋切到前台
                  browser_ax(action="tree") → 看页面上有什么语义控件
   ↓
agent 第 2 轮：   browser_find(descriptor={"k":"role","v":"button",...})
                  → 拿到 score=0.97，runner_up=0.32，唯一命中 → 可信
                  browser_click(target=descriptor)
                  browser_screenshot  → 确认到达了月报页
   ↓
agent 第 3 轮：   browser_network   → 看哪些接口返回月报数据
                  ↑ 用户的"预估金额"插件如果过期了，自动降级到这步：
                  拿请求 URL，照着 header 自己 POST 一份过去
   ↓
agent 第 4 轮：   整理成 xlsx 存盘，回报用户
                  生成可重复运行的 .py 文件，下次直接 `python xxx.py`
```

**关键点：人只说了"抓月报"。** agent 自己排步骤、自己选择描述符、自己 fallback、自己写脚本。下次同一家店抓同一天，agent 直接跑脚本；下次店铺改版，agent 自动重拾取描述符、自愈失败。

人在这中间的角色只有两个：**在 agent 卡住时按一下鼠标确认一个元素**（`browser_pick`/`Alt+Shift+A`），以及**重启服务 / 重载扩展**这两件排障的事。其余全是 agent 的活。

---

## 目录

- [为什么不用纯 CDP](#为什么不用纯-cdp)
- [架构](#架构)
- [快速开始](#快速开始)
- [接入 MCP](#接入-mcp)
- [工具清单](#工具清单)
- [元素识别：描述符 + 拾取器](#元素识别描述符--拾取器v110)
- [元素库：定位一次，以后按名字用](#元素库定位一次以后按名字用v134)
- [直连脚本：不开 MCP 也能驱动浏览器](#直连脚本不开-mcp-也能驱动浏览器v134)
- [事件真实度三档（系统级 SendInput）](#事件真实度三档methodosv133)
- [语义树定位](#语义树定位browser_axv120)
- [iframe / 跨帧](#iframe--跨帧v102)
- [两个档位](#两个档位)
- [排障](#排障)
- [部署到服务器（可选）](#部署到服务器可选)
- [这个项目做不了什么](#这个项目做不了什么)

---

## 为什么不用纯 CDP

从 **Chrome 136 / Edge 同版本**起：

> `--remote-debugging-port` 和 `--remote-debugging-pipe` **对默认用户数据目录不再生效**，
> 必须搭配 `--user-data-dir` 指向一个非标准目录。

[官方公告](https://developer.chrome.com/blog/remote-debugging-port)

后果是：想用纯 CDP 接管浏览器，就得开一个**全新的 profile** ——
你的生意参谋、拼多多后台、公司报表系统**全部要重新登录一遍**，而且日常那个浏览器还是操控不了。

**扩展方案绕开了这个限制**：扩展天然运行在你日常的 profile 里，登录态一个都不用重登。
这是本项目存在的根本原因。

---

## 架构

```
┌────────────────────────── 你的电脑 ──────────────────────────┐
│                                                              │
│   agent (WorkBuddy)                                          │
│        │  MCP / stdio                                        │
│        ▼                                                     │
│   本地 MCP 服务  ── 127.0.0.1:8765 ──▶  Chrome 插件 (MV3)    │
│   mcp_server.py      WebSocket            │                  │
│                                           │ content script   │
│                                           ▼                  │
│                                    你已登录的页面             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

| 组件 | 职责 |
|---|---|
| `extension/` | 在页面里动手：定位元素、派发事件、截图、抓包、读 Cookie |
| `server/` | 把 MCP 工具调用翻成插件指令，**并且是保持连接不断的那一方**（每 20 秒心跳） |

**为什么心跳要由服务端发**：MV3 的 service worker 空闲约 30 秒就会被浏览器回收，连接随之断开。
服务端定时发消息能重置空闲计时器，让连接在无人操作时也活着。

---

## 快速开始

### 1. 服务端依赖

**`server\.venv` 已经建好并装完依赖，这一步可以直接跳过。**

换机器或升级 Python 后才需要重建：

```bat
cd browser-bridge\server
install.bat
```

或手动：

```bat
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.org/simple/
```

> **别用清华源。** 实测在 pip 26 下清华源会返回空索引，报
> `Could not find a version that satisfies the requirement websockets (from versions: none)`，
> 看起来像网络问题，其实是索引源兼容问题。用 `-i https://pypi.org/simple/` 即可。

当前环境实测可用版本：`websockets 17.2` + `mcp 2.3.0`（mcp 2.x 把 `FastMCP` 改名成了
`MCPServer`，服务端已做双版本兼容，1.x / 2.x 都能跑）。

### 2. 加载扩展

1. Chrome 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序** → 选择 **`browser-bridge/extension`** 目录
   （注意是 `extension` 目录，不是外层 `browser-bridge`）

> **报「清单文件缺失或不可读取 / 无法加载清单」= 选错目录了。**
> 外层 `browser-bridge/` 里没有 `manifest.json`（它在 `extension/` 里面），
> 而 Chrome 要求**你选的那个目录下直接有 manifest.json**。
>
> 省事的办法：双击根目录的 **`加载扩展-选这个目录.bat`** —— 它会把正确的
> 绝对路径复制进剪贴板，在「选择文件夹」对话框里直接 `Ctrl+V` 粘贴即可。
>
> 加载成功后，`chrome://extensions` 上显示的扩展 ID 应当是
> **`ejajjndahiklljjjpnmefhmbinaegkdc`**（由 manifest 的 `key` 固定）。
> 如果是一串别的 ID，说明还是选错了目录。

> ⚠️ **扩展目录必须放在固定位置，不要放在带时间戳的临时会话目录**
> （例如 `C:\Users\<你的用户名>\AppData\Local\Temp\某个会话目录\`）。
> 这类目录会被清理工具删掉，Chrome 找不到文件就把扩展摘掉 —— 症状就是
> "前一天还好好的，第二天打开 Chrome 扩展没了，得重新加载"。
> 把 `extension` 目录放到一个稳定路径（本机实测用
> `D:\Tools\browser-bridge\extension`），重新"加载已解压"一次即可，
> 之后重启或升级 Chrome 都还在，不需要任何注册表策略或后台更新服务。

### 3. 验证

**先确认服务端没问题**（这一步能把「服务端问题」和「插件问题」彻底分开）：

```bat
cd browser-bridge
server\start-server.bat
```

（等价于 `server\.venv\Scripts\python.exe server\mcp_server.py --ws-only`。
起来后这个窗口留着，它就是服务端；关掉窗口 = 服务停止。）

另开一个终端：

```bat
server\.venv\Scripts\python.exe tools\selftest.py
```

看到 `握手成功` 并且心跳在打，说明服务端完全正常。

**再确认插件没问题**：任意打开一个网页，页面右下角会出现一个蓝色 **BB** 圆球
（快捷键 `Alt+Shift+Z` 唤起）。点开 → 点「**页面信息**」——
能弹出页面尺寸等信息，说明插件侧也通了。

---

## 接入 MCP

直接复制 `mcp-config.snippet.json` 合并进 agent 的 MCP 配置文件 ——
WorkBuddy 是 `~/.workbuddy/mcp.json`。**把下面两处路径换成你自己解压的位置**：

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "<解压位置>\\browser-bridge\\server\\.venv\\Scripts\\python.exe",
      "args": [
        "<解压位置>\\browser-bridge\\server\\mcp_server.py"
      ]
    }
  }
}
```

改完路径后重启 agent。**不需要手工启动服务** —— MCP 客户端会自己拉起 `mcp_server.py`。
（所以 `--ws-only` 那个终端要关掉，否则 8765 端口被占用会启动失败。）

---

## 自测工具

一组脚本，从外往里逐层验证。出问题时按顺序跑，能立刻定位到是哪一段断了。

| 脚本 | 验证什么 |
|---|---|
| `tools/consistency_check.py` | **跨文件名字契约**。manifest 文件路径、指令名、动作名、装配顺序有没有对不上的（这类错误最隐蔽，且报错含糊） |
| `tools/protocol_test.py` | **桥接协议闭环**。握手 / 指令回执 / 错误透传 / 5MB 大图过桥 / 心跳 / 断线快速失败 |
| `tools/mcp_client_test.py` | **agent 视角**。以 MCP 客户端身份连上，列出全部 `browser_*` 工具并真实调用一次 |
| `tools/locator_test.mjs` | **定位引擎**（112 项）。打分、三条阈值、歧义拒绝、改版容错、粗筛失效时的全量重扫、易变属性过滤、最小充分裁剪 |
| `tools/picker_test.mjs` | **拾取协议**（29 项）。`pick_start` / `pick_end` / 结果回传三种 type、多帧隔离、串号拒绝 |
| `tools/picks_test.mjs` | **拾取存储**（33 项）。同名覆盖、multi 倒序、上限 50、`get` / `drop` / `clear` |
| `tools/pick_dispatch_test.mjs` | **拾取投递通道**（37 项）。会话消息必须走 `broadcastFrames` 定向投递，**并用静态护栏拦住"改回 runtime.sendMessage 广播"**（那会让所有标签页一起进拾取模式） |
| `tools/ax_test.mjs` | **语义树定位**（39 项）。节点过滤、查询匹配、歧义拒绝、rect 计算、跨帧拒绝、临时附着的释放时机 |
| `tools/frame_logic_test.mjs` | **扫帧择优**。隐藏模板 vs 可见实例（淘宝滑块正是这个形态，v1.0.4 修的就是它） |
| `tools/retry_backoff_test.mjs` | **重连退避曲线**。验证冷/热两档间隔、以及健康连接不会被误拆（跑这个不用 `python`，直接 `node`） |
| `tools/osinput_test.py` | **系统级输入层**（73 项）。`INPUT` 结构体大小、字符→VK 映射、Unicode 路径、坐标归一化、风控正则、相对位移解析。加 `--live` 会做**坐标系往返自检**（用 SendInput 移光标再读回来比对，不点击、测完还原） |
| `tools/os_probe.html` + `tools/os_probe_run.py` | **事件真实度对拍**。网页统计 keydown/keyup/input 次数，脚本用系统级输入打字，用来实测「SendInput 有 keydown、CDP `char` 没有」 |
| `tools/elements_test.py` | **元素库存储**（28 项）。站点隔离、同名覆盖、描述符/选择器降级、`import_picks` 归档与跳过、坏文件容错、上限截断。纯离线 |
| `tools/publish_check.py` | **发布前自检**。扫真实账号 / 密码 / 内网地址 / 密钥，按 `.gitignore` 语义模拟"哪些文件会被提交"，并检查大文件与截图目录。**给别人看之前先跑一遍**（加 `--strict` 可挂 CI） |

```bat
cd browser-bridge
server\.venv\Scripts\python.exe tools\consistency_check.py
server\.venv\Scripts\python.exe tools\protocol_test.py
server\.venv\Scripts\python.exe tools\mcp_client_test.py
node tools\locator_test.mjs
node tools\ax_test.mjs
node tools\frame_logic_test.mjs
node tools\retry_backoff_test.mjs
```

还有一个专用来划清"服务端 vs 插件"责任边界的：

```bat
:: 终端 1：只跑服务端
server\.venv\Scripts\python.exe server\mcp_server.py --ws-only
:: 终端 2：假装自己是 Chrome 插件
server\.venv\Scripts\python.exe tools\selftest.py
```

`selftest.py` 能连通 ⇒ 服务端这半边没问题，故障必然在插件侧。

**手工起停服务端**（排障或临时用；正常用法不需要，agent 会自己拉起）：

```bat
server\start-server.bat   :: 前台起一个，窗口关掉 = 服务停
server\stop-server.bat    :: 释放 8765 端口
```

---

## 工具清单

一共 30 个工具，agent 直接用自然语言就能驱动。

### 看

| 工具 | 用途 |
|---|---|
| `browser_status` | 连接状态。**任何操作失败先调它**，区分链路问题与页面问题 |
| `browser_tabs` | 列出所有标签页，拿 `tabId` |
| `browser_frames` | **列出页面所有 frame**（含跨域 iframe）。「元素看得见却查不到」时先调它 |
| `browser_page_info` | 页面尺寸、视口、滚动位置，可附带正文文本 |
| `browser_query` | 查元素：返回稳定 CSS 路径、属性、文本、是否被遮挡 |
| `browser_find` | **按「元素描述符」定位**，只报告不点击。返回相似度/次高分/未命中属性 |
| `browser_ax` | **按语义树定位**（`role=textbox, name=账号`），抗改版最强的一档 |
| `browser_pick` | **让人在页面上点一下**，返回一个可复用的元素描述符。找不到元素时的终极手段 |
| `browser_picks` | 存取**人自己拾取**的那批描述符（`Alt+Shift+A` 攒的）。`action=list/get/drop/clear` + `name` 参数 |
| `browser_elements` | **元素库**：把定位过的元素按站点落盘，以后按名字取用，不必每次重新识别（v1.3.4） |
| `browser_read` | 读元素文本 / HTML / 输入框当前值 |
| `browser_screenshot` | 截图存文件，返回路径（整页 / 元素） |

### 动

| 工具 | 用途 |
|---|---|
| `browser_click` | 点击（选择器或坐标），自动滚进视口 + 遮挡检查。`method="os"` 可切系统级真实鼠标 |
| `browser_type` | 输入文字，**带回读核对**。登录/风控敏感场景用 `method="os"`（见下一节） |
| `browser_hover` | 悬停，触发下拉菜单 |
| `browser_press` | 按键：Enter / Tab / Escape / 方向键 |
| `browser_scroll` | 滚动页面 / 元素 / 内部容器 |
| `browser_drag` | 拖拽（pointer 序列或 HTML5 拖放）。`to_target` 支持**相对位移** `"+349,0"`；`method="os"` + `overrun` = 滑块撑到尽头（v1.3.4） |
| `browser_wait_for` | 等元素出现/消失 |
| `browser_evaluate` | 执行 JS。逃生舱 |
| `browser_risk` | **查当前页是不是踩到人机验证/风控**，并给出该怎么处理（v1.3.3） |

### 维护

| 工具 | 用途 |
|---|---|
| `browser_reload` | **热重载服务端的 `osinput` / `os_driver`** —— 改完这两个文件立刻生效，不用重启 WorkBuddy（v1.3.4） |
| `browser_mode` | 切换档位：`light`（默认，轻量）/ `debugger`（增强，走 CDP）。整页截图、`browser_ax`、`isTrusted` 场景要它 |

### 导航

`browser_goto` · `browser_close_tab` · `browser_activate_tab`

### 数据

| 工具 | 用途 |
|---|---|
| `browser_cookies` | 读 Cookie（含 **HttpOnly** —— JS 拿不到、只有扩展能读） |
| `browser_set_cookie` / `browser_clear_cookies` | 写 / 删 |
| `browser_network` | 抓接口：`start` / `stop` / `list` / `body` / `clear` |

**选择器支持四种写法**（这是 agent 用得最顺的一点）：

```
#id .btn            普通 CSS
//button[1]         XPath
text=提交订单       按可见文本匹配 ← 人话定位，最常用
label=用户名        按 label 文本找关联输入框
{"attrs":[...]}     元素描述符（v1.1.0 起，见下一节）
```

---

## 元素识别：描述符 + 拾取器（v1.1.0）

**这是桌面 RPA（影刀那类）比"选择器驱动"先进一代的地方**，也是本版本补上的部分。

### 差别在哪

- 我们原来说的"元素"，是**一串选择器字符串**：`#app > div > form > button`。命中即成功，
  命中多个就按可见面积排序取第一个 —— 谁才是"对的那个"完全没有语义判断。
  站点改版加个哈希类名、DOM 多包一层，这串字符串直接归零。
- 影刀说的"元素"，是**一个带权重的属性集合**：id / name / role / 文本 / 类名 / 层级各占多少分。
  定位时给每个候选逐属性算相似度、加权求和、择优录取。属性没被全改光，改版后它还能认出来。

描述符长这样（`browser_pick` 拾取出来的就是这个）：

```json
{
  "v": 1,
  "note": "登录页提交按钮",
  "attrs": [
    {"k": "testid", "v": "login-submit", "m": "eq", "w": 3},
    {"k": "text",   "v": "登录",          "m": "eq", "w": 2},
    {"k": "tag",    "v": "button",        "m": "eq", "w": 1, "pf": true}
  ]
}
```

`k`=属性名 · `v`=期望值 · `m`=匹配方式（`eq`/`contains`/`words`/`regex`/`fuzzy`）· `w`=权重 · `pf`=仅用于粗筛

### 三条接受条件，任一不满足就报错，绝不"凑合返回一个"

| 条件 | 默认值 | 拦的是什么 |
|---|---|---|
| `score ≥ minScore` | 0.62 | 不够像 |
| `score − Top2 ≥ minGap` | 0.12 | **歧义** ← 最值钱的一条 |
| `coverage ≥ minCoverage` | 0.4 | "全是勉强沾边的"虚假高分（分数好看但一条实锤都没有） |

第二条是整个机制的核心价值：**宁可报"歧义"让人来看，也绝不猜**。
猜错的代价是点到删除 / 提交 / 付款按钮上，比"点不动"严重得多。

### 两条使用路径

```
路径 A（全自动）：browser_find 传描述符 → 看 score/runner_up/misses → 确认后再 click
路径 B（agent 在场示教）：browser_pick → 人在页面上点一下 → 拿到描述符 → 存下来反复复用
路径 C（人先攒、agent 后取）：Alt+Shift+A 自己圈一批 → 按 Esc 存下 → agent 随时 browser_picks 取走
```

**路径 B 的适用场景**：canvas 画出来的控件、随机类名的第三方组件、一天改三版的运营页、
页面上有五个"确定"而你说不清是哪个。一次人工点击的成本，远低于 agent 试错十次。

**路径 C 是"人先示教、agent 后执行"该有的样子**：浏览器页面上按
`Alt+Shift+A`（或点 BB 球面板上的「拾取元素」）进入拾取模式，
**按住 `Ctrl` + 左键**点击目标元素（可连续点选多个），按 `Esc` 结束并存下
（存进 `chrome.storage.local`，最多 50 条）。
这条路**不需要 agent 在场** —— 人浏览页面时顺手把要操作的元素圈出来，过一会儿再让 agent 干活，
不必让一次调用一直挂在那儿等人点。

> **为什么确认键是 Ctrl+左键**：第一版是"左键即拾取"，实测容易手滑拾错，
> 而且与页面自身的点击语义混在一起，分不清是在浏览还是在拾取。
> 加上 Ctrl 之后，浏览与拾取两种意图彻底分开（影刀也是这个键位）。
> 单独左键只移动高亮框做预览，会提示"按住 Ctrl 再点"。
>
> **`Alt+Shift+A` 冲突了怎么办**：网页永远抢不过宿主客户端的热键（千牛实测抢不到 `Alt+Shift+P`），
> 所以只能避让。真被占了就用面板上的「拾取元素」按钮，它是完全等价的入口。

### 跨帧拾取：iframe 里的元素也能拾

千牛、生意参谋这类后台**把登录框放在 iframe 里**。鼠标移到 iframe 上时，
事件由 iframe 文档自己派发 —— **主文档根本收不到** mousemove / click。
第一版的拾取只起主文档的会话，于是 iframe 里的账号密码框"怎么都拾取不到"，
连 Esc 也失效（键盘焦点在 iframe 里，keydown 同样落不到主文档）。

现在的做法：**一个标签页的所有帧同时各起一份会话**，各自高亮自己帧内的内容。
鼠标在哪个帧，那个帧自然就会响应，彼此互不干扰；`Esc` 在任意一帧按下都能结束整次拾取，
由 service worker 统一把其余帧收干净。

拾取结果会带上 `frameId` / `frameUrl` —— 不记这两个字段，描述符就会指向
"主文档里某个长得像的元素"，定位十有八九找错。

`browser_pick` 会先在页面上盖一层高亮遮罩，鼠标移过时实时预览"这次会拾取到什么"：
- **按住 `Ctrl` + 左键 = 确认拾取**；单独左键只是移动高亮框预览，不会拾取
- 默认 `anchor=semantic` 会从鼠标位置**向上冒泡到 button / a 这类语义元素** ——
  直接拾取 `<span>` 生成的描述符下次多半就飘了；
  `Ctrl+Alt+左键` = 严格选中鼠标正下方的元素（不冒泡）
- `multi=true` 连续拾取多个，按 `Esc` 一次性全部交回
- `Esc` / 右键取消；拾取期间页面不响应任何点击（事件在捕获阶段就被拦下了）

描述符生成时有两条铁律：**过滤易变属性**（`css-1x2y3z`、`data-v-7a3c1b2c`、16 进制 id、
`style` 里的定位值全部丢弃），以及**最小充分裁剪**（属性够唯一就行，
但即使页面只有一个匹配也至少保留 2 条实义属性 —— 不给改版留"一击必杀"的空档）。

### 和老代码的关系：加法，不是替换

`target` 传**字符串** → 一切照旧走 `adapter.js` 的老路径，行为零变化；
`target` 传**描述符对象** → 才进入 `locator.js`。
所以已有的 23 个老工具、全部自测脚本、已经跑通的流程都一行没改。

---

## 元素库：定位一次，以后按名字用（v1.3.4）

**它解决的是「每次都要重新识别」这件事。**

在此之前元素只有两条来路，都不持久：
- agent 每次 `browser_find` 现场重扫页面；
- 人拾取的结果存在扩展的 `chrome.storage.local`（`bb_picks`，上限 50 条）——
  那是**浏览器里的暂存**，不是项目资产：清一次扩展数据、换一个会话就没了，
  也没按站点归档，攒到几十条就分不清哪条是哪条。

现在多一步落盘：`server/elements/<域名>.json`，按站点分文件。

```
browser_elements(action="save", name="登录按钮", target="#login-btn")
        ↑ target 给选择器时，服务端会让页面把它**升级成描述符**再存（描述符才抗改版）

browser_elements(action="get",    name="登录按钮")   → 拿回 descriptor
browser_elements(action="locate", name="登录按钮")   → 直接定位，返回坐标/匹配质量
browser_elements(action="list")                      → 不传 site：列出所有站点汇总
browser_elements(action="import_picks")              → 把人拾取的那批一次性收进来
browser_elements(action="drop",   name="登录按钮")
```

几条设计上的取舍：

- **存描述符而不是选择器**：选择器一改版就归零，描述符（多属性加权打分）还能认出来。
  只给得出选择器时也存，但标 `fidelity="selector"`，提醒你改版后重新示教。
- **同名覆盖**：人对同一个元素又示教一遍，算"更新"，不是再来一条。
- **按站点分文件**：同一个名字（"登录按钮"）在不同站点指的不是同一个元素；
  分文件既避免串味，也方便直接打开某个 json 看/改。
- **不唯一命中会警告**：`quality.unique=false` 时返回里带 warning ——
  这条描述符以后可能点到别的元素，最好把选择器写具体点再存一次。

存储逻辑有独立单测：`server/.venv/Scripts/python.exe tools/elements_test.py`（28 项，纯离线）。

---

## 直连脚本：不开 MCP 也能驱动浏览器（v1.3.4）

MCP 那条线是给 agent 用的，但有个绕不开的短板：**改了服务端代码必须重启服务进程**，
而服务进程由宿主拉起 —— 重启就意味着自定义连接器要重新信任，当前会话直接失去浏览器能力。
（这不是假想：2026-10-15 为加载新代码停了一次服务，本会话的 `browser_*` 就全断了。）

`server/bb_client.py` 把另一条路封装好了：**自己起 WS 服务，插件照常连上来**，
于是"服务端能力 → 脚本"之间不再需要 MCP 这一跳。改完代码即时生效、流程可固化、可无人值守。

```python
import sys; sys.path.insert(0, "<browser-bridge>/server")
sys.path.insert(0, "<browser-bridge>/tools")
from bb_client import Browser
from slider_solve import solve_slider

b = Browser()
b.wait_extension(30)
r = solve_slider(b, tab_id, overrun=90)
b.close()
```

已经脚本化的两条流程：

| 脚本 | 做什么 |
|---|---|
| `tools/slider_solve.py` | 过滑块：自动找风控帧、量轨道几何、撑到尽头、判定结果。`--dry-run` 只看不拖 |
| `tools/kn_login.py` | 千牛/淘宝登录全链路：填账号 → 填密码 → 点登录 → 过滑块 → **补点登录** → 判跳转 |

账号密码只从命令行/环境变量进来（`BB_TAOBAO_USER` / `BB_TAOBAO_PASSWORD`），不写文件、不落日志。

⚠️ **端口互斥**：browser-bridge 只能有一个服务端，插件也只连得上一个。
MCP 服务在跑时脚本会因端口占用起不来（报错里会把两个选项都写清楚）。

---

## 事件真实度三档：`method="os"`（v1.3.3）

同一个"输入文字"，可以用三种方式产生，真实度差得很远：

| 档 | 事件来源 | 页面看到的东西 | 什么时候用 |
|---|---|---|---|
| 合成 DOM 事件 | `dispatchEvent` | `isTrusted=false` | 轻量档默认。够快，绝大多数场景够用 |
| CDP `Input.*` | 浏览器调试协议 | `isTrusted=true`，**但没有 keydown/keyup** | 增强档。需要可信事件时 |
| **系统级 SendInput** | **Windows 硬件输入栈** | **与真人敲键盘完全一致** | **登录 / 风控敏感 / CDP 被拦时** |

### 为什么会有第三档：一次真机实测

2026-10-15 用 CDP 在淘宝登录框里填账号密码，点登录立刻弹出 nc 滑块；
而人自己在同一个框里点一下、让浏览器自动填充保存的密码，**一次就过、没有验证码**。
于是在一个探针页（`tools/os_probe.html`，统计 DOM 事件次数）上把两条路都跑了一遍，
输入同样的字符序列 —— 这是量出来的结果，不是推测：

| 输入方式 | keydown | keyup | input | 值 |
|---|---|---|---|---|
| 系统级 SendInput | **11** | **11** | 6 | `Ab3:中文` ✅ |
| CDP `type:'char'` | **0** | **0** | 3 | `Ab3` ✅ |

两条路**结果都正确**，但 CDP 那条是"3 个字符输进去了、一次按键都没有"。
风控只要把 `input` 和 `keydown` 两个计数一比，就知道是机器。
（根因在 `cdp.js` 的 `typeText()`：它用的是 `{type:'char'}` ——
这是 CDP 特有的"直接插一个字符"，按定义就不产生按键事件。）

### 怎么用

```
browser_type("#fm-login-id", "你的账号:子账号", method="os")   # 系统级键盘
browser_click("text=登录", method="os")                      # 系统级鼠标（真光标）
browser_drag("#nc_1_n1z", "+349,0", method="os")             # 系统级拖拽
browser_risk()                                               # 先查有没有人机验证
```

- **键盘（`os_type`）不需要坐标**：先点一下目标聚焦，再用 SendInput 逐字敲。
  输入法会被临时关掉再恢复（否则字母会进输入法变成候选词），
  中文等非 ASCII 字符走 `KEYEVENTF_UNICODE` 直送 —— 实测含中文的账号串一次输入完全正确。
- **鼠标（`os_click` / `os_drag`）需要屏幕物理坐标**，由「顶层视口 CSS 坐标 + 视口原点」换算得到。
  坐标换算不可信时**直接拒绝执行** —— 点错位置的代价比不点大得多。
- **节奏是按人的习惯铺的**：基础间隔带抖动，小概率插入"想了一下"的长停顿；
  拖拽还带弧线、变速和到位停顿。等距的间隔本身就是脚本特征。

### 两个坑，都是踩过才知道的

1. **`SetProcessDpiAwarenessContext` 不能省。**
   Python 默认是 DPI 不感知进程，Windows 会把 Win32 几何 API 的返回值按 1/1.5 虚拟化
   （本机实测：主屏 1280×720 / 虚拟桌面 3840×1440  →  真实是 1920×1080 / 5760×2160）。
   而 SendInput 的绝对坐标**永远按真实物理桌面归一化**，两边不在一个坐标系里 ——
   光标会整体按 1.5 倍偏移，**且不报任何错**。所以 `osinput` 在导入期就把进程切成
   per-monitor 感知，并提供 `calibrate()` 做往返自检（实测误差 0px）。
2. **系统级键盘打的是「前台窗口」。**
   如果发密码的当口用户切走了窗口，密码就会被敲进别的程序里。
   所以键盘/鼠标操作全程带 `guard`：每个字符送出前校验前台窗口仍是目标窗口，
   一旦不对**立刻中止**，宁可这次任务失败。

### 人机验证：默认转人工

`browser_risk()` 会扫当前标签页所有 frame 的风控特征。命中时 `advice` 写得很直白：
**默认请人来做**。理由是滑块类验证连试两次返回的往往是同一串错误码 ——
那说明是"机器判定"而不是"位置没对准"，继续重试有升级为图片点选、甚至给账号打风险标记的可能。

自动化的边界就在这里：遇到必须由人完成的环节，agent 的价值是**准确求助**，不是硬闯。
（上面那次系统级输入登录生意参谋，实测**没有出现验证码帧**，一次通过。）

### 滑块验证：撑到尽头，不是精确对齐（v1.3.4）

2026-10-15 在千牛登录滑块上把这件事彻底做实了。先说结论：

**这类滑块的判据是「滑块有没有到达终点区域」—— 拖过头不算错，精确对齐反而最像机器。**

滑块被拖过终点后，组件自己会把它夹在末端，多出来的部分只是指针在走；
而"算好距离、精确停在终点值上"是任何真人都做不到的事。实测：按轨道几何精确对齐落点，
连续两次被判 `error:zAuBTf`；改成**一口气撑过终点 150px** 后，一次就过。

用法（`overrun` 是 CSS 像素，服务端自动乘 dpr）：

```
browser_risk()                                  # 先拿风控帧 frameId
browser_query("#nc_1_n1z", frame=<帧id>)         # 量滑块
browser_query("#nc_1__scale_text", frame=<帧id>) # 量轨道宽度
browser_drag("#nc_1_n1z", "+430,0",              # 轨道剩余 369.5 + 余量 60
             method="os", overrun=90,            # ★ 冲过终点 90px，不回拉
             frame=<帧id>)
```

`overrun > 0` 时轨迹是**直冲、不画弧线、不回拉**（用 `q**k` 前快后慢，像"发力推到底"），
松手前还会象征性地"再顶一下"。`overrun = 0` 保持原来的"过冲后回正"，那条路是给
**要对齐某个位置**的拖拽（自研拖拽、排序列表、拼图缺口）用的，别混。

**四个必须知道的判据/坑：**

1. **判通过看「滑块元素在不在」，不是看「风控帧在不在」**。
   风控帧通过验证后**不会从 frames 列表里消失** —— 拿它当判据会把"已经过了"
   误判成"还在风控"，然后无限重试。
2. **滑块过了之后得再点一次「登录」**。表单不会自动重新提交，页面会静静停在登录页
   （账号密码都在、按钮也能点、一条报错都没有），特别容易误判成"账号密码不对"。
3. **别手工累加 iframe 偏移**算起点：读到的 rect 可能来自过期页面状态，和实时算的能差 20+ px，
   起点落到滑块外面 → 拖动压根没开始，页面却报"验证失败"。用相对位移 `"+430,0"`。
4. **登录框上系统级鼠标会跑偏**（实测把账号框覆盖成了密码串），
   所以聚焦用应用层点击、输入用系统级键盘：`os_type(..., focus="bridge")`。

**两条使用路径**：MCP 工具（上面那串）；或直连脚本
`tools/slider_solve.py --tab <id>` / `tools/kn_login.py --auto-slider`（见"直连脚本"一节）。

失败两次返回同一串错误码 = **机器判定**，不是位置没对准 —— 把 overrun 加大再试**一次**，
仍不成请转人工。经验已固化成 skill `browser-slider-verify`。

## 语义树定位：`browser_ax`（v1.2.0）

三档定位能力，一代比一代抗改版：

| 档位 | 绑的是什么 | 前端重写 DOM 后 |
|---|---|---|
| `browser_query` | DOM 结构：`#app > div > form > input:nth-child(2)` | **归零** |
| `browser_find` | 属性集合：多属性加权打分 | 大部分还能认出来 |
| **`browser_ax`** | **语义**：`role=textbox, name=账号` | **不受影响** |

一个输入框不管外面套了几层 div、类名换了几轮哈希，它还是 `textbox`；
按钮上的字不管用什么标签实现，用户看到的还是"登录"。

这层语义浏览器自己就维护着一份 —— **无障碍树**（Accessibility Tree，屏幕阅读器读的就是它）。
CDP 的 `Accessibility.getFullAXTree` 能把整棵吐出来，每个节点自带 `role` / `name` / `value` / 状态。
**这就是桌面 RPA 在 Windows 上走 UIAutomation 的同一个思路**，浏览器里的等价物。

### 用法：三步

```
browser_ax(action="tree")                                   # 先看页面上有什么
browser_ax(action="query", role="textbox", name="账号")      # 确认，拿节点 + 坐标
browser_ax(action="click", role="button", name="登录")       # 按同一组条件点下去
```

`click` 走的是 **CDP 真实鼠标事件**（`isTrusted=true`）—— 这条路本来就是为
"选择器失效时还能点得动"准备的，而合成事件在登录框、风控组件上一律被拦，
和过淘宝滑块用的是同一条通道。

### 三条设计上的取舍

- **命中多个就拒绝执行**，并列出全部候选要求收紧条件或给 `index`。
  点错比点不动严重得多，语义定位也一样会撞车，不能默默取第一个。
- **临时附着、用完就撤**。调 CDP 必须先 `debugger.attach`，而那会在浏览器顶部挂一条
  "正在调试此浏览器"的黄条。所以增强档（本来就附着）直接用；轻量档临时附着、
  查完立刻释放 —— 不能因为一次查询就把黄条长期留在你浏览器上。
- **目标在 iframe 里时明确报错**，不硬算坐标。跨帧坐标要走 `browser_click` 的元素路径
  （先 `browser_pick` 拾取它）。但 `tree` / `query` **能看见 iframe 内的节点**
  （节点带 `frameId`）—— 这本身就很值钱，等于多了一只眼睛。

---

## iframe / 跨帧（v1.0.2）

**国内一大批后台把内容区放在 iframe 里**，生意参谋就是最典型的例子 —— 它的登录表单压根不在主文档：

```
主文档 https://sycm.taobao.com/custom/login.htm
  └── iframe#alibaba-login-box → https://havanalogin.taobao.com/mini_login.htm   ← 账号密码框在这里
```

早期版本把 `frameId` 写死成 0、只认主文档，于是 `query`/`click` 在这类页面上**全部 0 命中**。
现在所有读取与操作类工具都接受一个 `frame` 参数：

| `frame` 取值 | 行为 |
|---|---|
| 不传 / `"auto"`（**默认**） | 先主文档；没命中就**自动逐个 iframe 找**，命中时返回值里带 `frameId` / `frameUrl` |
| `"top"` | 只在主文档，不扫帧（明确知道目标在主文档时用，省时间） |
| `"all"` | 每帧都跑一遍，返回 `{frames:[...]}`。适合先摸清页面结构 |
| `<数字>` | 指定 frameId。用 `browser_frames` 拿到 |

**哪些脚本全帧注入、哪些只主文档**（v1.3.1 定型）：

| 文件 | `all_frames` | 为什么 |
|---|---|---|
| `net-hook` / `net-relay` | ✅ | 抓包要覆盖每个帧自己的 fetch/XHR |
| `config` / `adapter` / `locator` / `actions` | ✅ | 定位与操作的实现必须和元素在同一帧 —— 这是 iframe 内可操作的前提 |
| `picker` | ✅ | 拾取靠帧内鼠标事件；主文档收不到 iframe 里的点击 |
| **`router`** | ✅ | **SW 指令的收件口**（MAP + `onMessage`）。少了它，iframe 就是"有手没耳朵" |
| `panel` / `main` | ❌ | BB 小球与面板只能有一份，挂进 iframe 会盖住那个小框 |

**只有面板仍是按需注入**：`tabs.js` 的 `CONTENT_FILES_FRAME` 会剔掉 `panel.js` / `main.js`；
`main.js` 的 `boot()` 里还有第二道保险 —— 只有 `window.top === window` 才挂面板、才发保活 ping。

> **v1.3.0 的教训（v1.3.1 修的）**：当时把「消息路由」留在 `main.js` 里，而 `main.js`
> 所在组是 `all_frames: false`。于是 iframe 里注入了定位与拾取的全部实现，
> 却**没有任何消息监听器** —— `frames` 探针永远报 `injected: false`，
> `query` / `click` / `type` / `read` 一旦落到 iframe 就报"注入后无响应"，
> 千牛 / 生意参谋这类把登录框放进跨域 iframe 的后台等于完全不可用。
> 修法就是让它独立成 `router.js` 并全帧注入。
>
> 判据：**执行体在哪一帧，收件口就必须在哪一帧。** 两者一旦错位，
> 症状是"元素看得见、就是操作不了"，而且报错含糊（表现为神秘超时）。

**扫帧上限 8 个**。淘宝/拼多多这类页面动辄几十个埋点 iframe，不设上限会明显拖慢。

**但「命中即返回」是错的**（v1.0.4 修正）：淘宝 nc 滑块在页面里同时存在「隐藏模板」与
「真实实例」，而模板所在帧的 `frameId` 更小 —— 按旧逻辑会先命中模板（`rect` 全 0）就返回，
agent 拿到一个 0×0 的元素，拖拽直接打空。现在改成**并发取回所有帧的结果，
有可见命中就优先用可见的**；全都不可见时才退回第一个非空结果。
多个帧都有命中时，返回里的 `frameSweepNote` 会列出各帧与可见性。

### iframe 内的增强档：换算坐标，而不是降级

CDP 的 `Input.dispatchMouseEvent` 坐标是**顶层视口**的 CSS 像素，而 iframe 内元素的
`getBoundingClientRect()` 是相对**该帧**的。直接相加是错的 ——
错的结果不是「点不动」，而是**点到旁边的元素上**，可能误触提交、删除、支付。

v1.0.2 时这里选择了保守降级（退回合成事件）。但降级的代价很大：`isTrusted=false`，
遇到行为风控（淘宝滑块那类）一律被拦。所以 v1.0.3 起改成正面换算。

**换算方法（v1.0.4 定稿）**：从目标帧沿父链向上，每层在父帧里按 URL 找到对应的
`<iframe>` 元素，把它的 `left/top` 累加起来。

```
偏移     = Σ 各层 iframe 元素在父帧中的 left/top
顶层坐标 = 帧内坐标 + 偏移
```

**为什么不用 `window.screenX` 差值**（v1.0.3 的做法）：实测在 Chrome 155 上**不可用** ——
跨域帧的 `screenX/screenY` 会被**对齐成与顶层相同**，差值恒为 0（隐私保护行为）。
当时靠下面第 1 道校验兜住了，没有点错位置，但换算等于没做，于是每次都退回合成事件。

**为什么能读到 iframe 的位置**：「跨域读不到 iframe 的位置」是个常见误解 ——
读不到的是 iframe 的**内容**；iframe **元素本身**属于父文档，
`getBoundingClientRect()` 完全可读。这正是这套换算能成立的基础。

换算结果要过**两道校验**，任一不过就退回该帧内的合成事件（并在返回值里说明原因）：

1. 换算后的点落在页面里**某个 iframe 的矩形内** —— 目标帧的祖先必然在主文档里，
   这条不成立就说明偏移量是系统性算错的（专门拦「算错了、但恰好还没跑出视口」）；
2. 换算后的点落在顶层视口内。

匹配不到对应 iframe、或匹配到多个同 URL 的 iframe 时，**拒绝猜测**并回退 ——
猜错的代价是点到别的地方，比点不动严重得多。

返回里 `converted: true` + `offset` / `convertChain` 表示走了跨帧换算；
出现 `degradedFrom: "debugger"` 表示退回了合成事件。

> **实测结论**（2026-10-14，生意参谋登录页）：跨域 iframe 内拖拽淘宝滑块**一次通过**，
> 抓包出现 `/_____tmd_____/slide` 请求，登录成功进入首页。也就是说
> **CDP 顶层 Input 事件确实能命中跨域 iframe（OOPIF）内的元素**，
> 不需要额外 `Target.attachToTarget` 挂会话。

### 锚点后缀：拖拽要落到边缘，不是中心

定位表达式支持 `>>` 锚点后缀：

```
#nc_1_n1t>>right       轨道右边缘
#nc_1_n1t>>right:6     右边缘再往里 6px
.list>>bottom          列表底部
```

默认取元素中心 —— 这对"点一下"够用，但滑块验证码必须把滑块拖到**轨道最右端**，
拖到中心等于没拖。用后缀表达，就不必为此再给上层工具开一堆坐标参数。

### 拟人轨迹

`browser_drag` 在增强档走的是拟人曲线，不是匀加速直线：

| 阶段 | 做法 |
|---|---|
| 接近 | 从左上飘到起点（4~12 步） |
| 迟疑 | 按下前等 120~320ms —— 人不会"移到就按" |
| 按下 | 按下后再静止 70~180ms 才动 |
| 拖行 | 速度峰值在 **35%** 位置（不是 easeInOutCubic 的 50%），纵向弧线漂移 ±3px |
| 步进 | 每步耗时抖动 0.55~1.5 倍，**等距间隔是脚本特征** |
| 收尾 | 到位后停 160~420ms 再松手 |

这些"多余"的随机不是装饰：行为风控看的正是轨迹形状和时序 —— 完美直线、等距间隔、
零延迟起步，任一条都能暴露脚本。

> `browser_evaluate` 仍然只在明确传数字 `frame` 时才在 iframe 里执行 ——
> "在 iframe 里跑任意 JS"属高危操作，不该由"自动猜"决定跑在哪一帧。

---

## 两个档位

| | 轻量档（默认） | 增强档 |
|---|---|---|
| 事件来源 | content script 合成 DOM 事件 | `chrome.debugger` → CDP |
| `isTrusted` | `false` | **`true`** |
| 浏览器提示条 | 无 | 顶部常驻「正在调试此浏览器」 |
| F12 开发者工具 | 可正常使用 | **该页无法同时打开** |
| 拖拽 | 一般场景可用 | 真实鼠标轨迹，能过 `setPointerCapture` |
| 整页截图 | 滚动拼接（吸顶元素会重复） | 一次成型，无拼接痕迹 |
| 抓包 | 仅页面自身 fetch/XHR | 全量资源 + 完整响应体 |

切换方式：插件弹窗点「增强」，或让 agent 调 `browser_mode("debugger")`。

**什么时候必须切增强档**：

- 拖拽完全没反应（`setPointerCapture` / `isTrusted` 校验）
- 点击后页面毫无响应，但你手动点明明可以
- 需要完整响应体的抓包
- `browser_evaluate` 报 CSP / `unsafe-eval` 错误
- 需要干净的整页长截图

**代价提前说清**：切到增强档后，浏览器顶部会出现黄条，
并且**你手动打开该页的 F12 会失败**（同一个标签页只能有一个调试客户端）。
不使用时在弹窗里切回轻量档即可释放。

> **还有第三档：系统级 SendInput（v1.3.3）。** 它不是一个"档位开关"，而是每次调用的
> `method="os"` 参数 —— 因为它的前提条件更苛刻（窗口必须在前台、会真的移动系统光标），
> 不该被一个全局开关悄悄打开。什么时候必须用它、实测数据、两个坑，见
> [事件真实度三档](#事件真实度三档methodosv133)。

---

## 排障

| 现象 | 原因与处理 |
|---|---|
| **扩展错误页刷出 `ERR_CONNECTION_REFUSED`（ws://127.0.0.1:8765）** | **这是最常见的第一个报错，不是 bug —— 服务端还没启动。** 这条红字是 Chrome 自己打的（JS 无法屏蔽），但它只说明「8765 没人监听」。处理：重启 WorkBuddy（MCP 客户端会自动拉起服务端），或双击 `server\start-server.bat` 手工起一个。服务一起来，插件最迟 5 秒内自动连上（v1.3.2 起），红字不再新增。 |
| 弹窗显示「未连接」 | 同上。面板里会直接给出该怎么做，不用猜 |
| 装了扩展但页面没有 BB 圆球 | 扩展刚装时**已打开的旧页面不会自动生效**，刷新一下（F5）。之后插件会自动补注入 |
| 「扩展上下文已失效，请刷新页面」 | 你重载了扩展，旧页面的 content script 失效了。F5 即可 |
| 点得动但页面没反应 | 大概率需要增强档。也可能是被遮罩挡住 —— `browser_click` 的返回值里会写明 |
| 拖拽无效 | 直接切增强档 |
| attach 失败：`Another debugger is already attached` | 该页开着 F12，或别的调试扩展在占用。关掉再试 |
| `chrome://` 页面操作失败 | 浏览器内部页禁止注入，这是设计如此，换普通网页 |
| 端口 8765 被占用 / 服务端启动即退出 | 有另一个实例在跑。打开前先双击 `server\stop-server.bat` 清掉，或改 `server/config.json` 的 `port`（同时要改插件弹窗里的地址） |
| 输入了但值是空的 | `browser_type` 返回里 `match: false` 会告诉你。多半是页面校验规则把值清掉了 |
| 截图是全白的 | 页面高度超过 16384px 的设备像素上限被截断了，返回值 `warnings` 里有说明。切增强档 |
| **扩展隔天就没了 / 要重新加载** | 扩展目录放在了会被清理的临时会话目录。把 `extension` 挪到固定路径（如 `D:\Tools\browser-bridge\extension`）再"加载已解压"一次，之后不再掉。**不要用企业策略强制安装来"解决"这个** —— 见下一条 |
| **强制安装后开关灰色 / 一直"正在更新"** | `disable_reasons:[256]` = 策略禁用。本机实测两个坑：① **HKLM 已有别的扩展的 `ExtensionInstallForcelist`（如点石插件），机器级策略压制 HKCU**，Chrome 压根不去拉你的 `update.xml`；② 本机更新服务在 `127.0.0.1`，Chrome 拉不到就卡在"正在更新"。**个人单机用请直接用"加载已解压"，别碰强制安装策略**；企业批量分发（有域控 + 内网 HTTPS 更新源 + 管理员权限）才走[内部分发与部署.md](docs/内部分发与部署.md)第 3、5 节 |

### 关于那个 ERR_CONNECTION_REFUSED，说清楚一点

这是本工程唯一一个「一定会看到、但完全正常」的报错。原因在于服务端的启动方式：

- 正常用法下，**服务端是被 agent 的 MCP 客户端拉起的**，你不该手动开它；
- 所以在「装好插件」到「重启 agent」之间，8765 必然是空的；
- 插件这时只能反复重试，而每一次失败 Chrome 都会往控制台打一条红字 —— 这条日志由浏览器产生，JS 侧既不能接管也不能静默。

工程上能做的只有**降低重试频率**。插件为此分了两档退避（v1.3.2 收紧过，见下）：

| 状态 | 重试间隔 |
|---|---|
| 从没连上过（服务端没启动，最常见的常态） | 1→2→4→**5 秒封顶** |
| 连上过一次之后又断了（服务端大概只是重启了） | 1→2→**3 秒封顶** |

> **v1.3.2 为什么把 30 秒 / 15 秒压到 5 秒 / 3 秒**：原先的上限太长，代价是**服务端
> （随 WorkBuddy 拉起）起来之后，插件最坏要干等 30 秒才接上**，体感就是"插件连本地服务很慢"。
> 而那条 `ERR_CONNECTION_REFUSED` 只出现在**扩展自身 service worker 的控制台**
> （`chrome://extensions` → Service Worker → 检查视图），不是页面控制台，平时根本没人看 ——
> 为一份看不见的日志牺牲连接体验不划算。回环地址上的重试本身也几乎不产生成本。

另外，面板和弹窗一点开就会立刻触发一次重连，所以「我不想等」随时可以手动催。

**插件侧调试**：`chrome://extensions` → 找到本扩展 → 点「service worker」进入后台控制台。

---

## 部署到服务器（可选）

默认只监听 `127.0.0.1`，**不出网、零暴露**。改成监听内网/公网地址在技术上完全可行，但要清楚代价：

> 你的浏览器会变成一个**挂在网络上的可遥控端点**。
> 谁拿到那个地址和 token，谁就能点你的生意参谋、翻你的拼多多后台、读你的登录 Cookie。

代码里有一条**硬规则**：监听非回环地址时，`token` 为空直接拒绝启动 —— 不给"先跑起来再说"的机会。

真要走这条路，四件事一件都不能省：

1. 设置一个 32 位以上的随机 `token`（`server/config.json`）
2. 用 `wss://` 而不是 `ws://`（前置 Nginx / Caddy 做 TLS 反代）
3. 只绑内网地址，不要挂公网
4. MCP 那一端用 `--http` 启动，同样加 TLS

```bat
server\.venv\Scripts\python.exe server\mcp_server.py --http
```

插件弹窗里把地址换成 `wss://你的域名/ws`，并填上同样的 token。

### ⚠️ 一个实例只服务一个人

`bridge.py` 里 `self._ws` 是**单个槽位**，新连接会顶掉旧连接 —— 这是**刻意的**：

```python
# 只保留一条连接：新连接顶掉旧的，避免指令发给了错误的浏览器
if old is not None and old is not websocket:
    await old.close(code=4002, reason="superseded by new connection")
```

原因很实在：MCP 工具（`browser_click(...)`）里**没有"发给谁"这个参数**。
一个服务端接多个浏览器时，agent 说"点一下登录"，服务端不知道该发给谁 ——
**发错就是把 A 的操作作用在 B 的浏览器上**，比重连失败危险得多。

**所以：多用户 = 多实例**（不同端口 + 不同 token），不要指望共用。

### 给同事批量装（让用户零操作）

两条关键机制已经内置：

1. **扩展 ID 已固定**（`manifest.json` 的 `key` 字段 → `ejajjndahiklljjjpnmefhmbinaegkdc`）。
   不固定 ID 的话，同事把文件夹放在不同路径，ID 就各不相同，企业策略没法精确指定。
2. **支持企业策略下发配置**：扩展读 `chrome.storage.managed`，优先级高于用户手填；
   被策略锁定时面板里的输入框自动只读、按钮显示"由企业策略锁定"。

于是 IT 一次性下发策略（装扩展 + 配地址和 token），同事侧**什么都不用做**：
打开 Chrome 扩展已在、已连上，也不用知道 token 是什么。

完整的部署材料都在 **`docs/内部分发与部署.md`**，配套文件：

| 文件 | 用途 |
|---|---|
| `docs/内部分发与部署.md` | 决策表 + 本机常驻服务 + token 分发四方案 + 服务器部署步骤 + 风险 |
| `server/install-local-service.bat` | **一键装机（最常用）**：建 venv → 装依赖 → 注册登录自启（**HTTP 模式**）→ 启动自检 |
| `server/start-http-server.bat` | 手工启动常驻服务：WS `8765` 给扩展 + HTTP `8766` 给**所有** agent 会话（多会话共用必须走这个） |
| `server/uninstall-local-service.bat` | 完整卸载（只终止带 `--http` / `--ws-only` 的进程，不误伤 agent 拉起的 stdio 实例） |
| `server/deploy/install-server.sh` | Linux 服务器一键部署（建用户 / venv / token / systemd / 自检） |
| `server/deploy/browser-bridge@.service` | systemd 模板，支持多实例（加固项已配好） |
| `server/deploy/nginx-snippet.conf` | wss 反代 + 长连接超时 + 更新分发路径 |
| `server/deploy/extension-policy.reg` | Windows 注册表策略：静默安装 + 下发 token |
| `server/deploy/extension-update.xml` | 私有更新清单（企业分发的标准做法） |

> ⚠️ **同一台机器上不要同时装自启服务和用 agent** —— `mcp_server.py` 一个进程同时提供
> WebSocket 与 MCP，两者会抢 8765 端口，先起的赢、后起的静默退出。
> 安装脚本会检测并劝退；两种情况都要就改用 `--http` 模式共用进程（见部署文档 2.4）。
>
> 同一个 token 别发给两个人；泄漏一个 token = 那台浏览器被接管。

---

## 这个项目做不了什么

如实说明，避免误用：

- **不能绕过付费墙、登录墙**。它只用你**自己已经登录**的身份做你**手能做的操作**，不做越权访问。
- **不能改响应体**。MV3 移除了阻塞式 `webRequest`，`declarativeNetRequest` 只能拦截 / 重定向 / 改 header。
- **抓不到请求头里的凭据**。`Authorization` / `Cookie` 等在入库前会被打码（见 `config.js` 的 `SENSITIVE_HEADERS`）——
  这是故意的，抓包是为了看接口结构，不是把凭据抄一份存到磁盘上。
- **轻量档过不了严格的机器人校验**。`isTrusted` 恒为 `false`，这是浏览器的硬约束，只有增强档能解。
- **增强档下 iframe 内的元素可以点击**（CDP 坐标事件天然跨 frame），但**语义定位要按 frame 区分**——
  `browser_ax` 的 `tree` 跨帧，`query/click` 单帧。**v1.3.1 起** iframe 内元素才真正可用
  （每帧一份本地 picker + 每帧一份消息路由 router.js）。
- **单个标签页同一时刻只能有一个调试客户端**。用了增强档，那个页面你就没法开 F12。

### 合规红线

- 只用于**你自己有权限的环境和账号**。
- 抓包、读 Cookie 属于高敏感操作，数据不要外传、不要分发。
- 不要用它批量构造请求去打别人的接口 —— 那是攻击行为，不是自动化。
- 涉及个人信息（客服聊天记录、客户名单等）时，遵守公司的数据合规要求。

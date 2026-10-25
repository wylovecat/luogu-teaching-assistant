# AGENTS.md — 洛谷教学助手

给在这个仓库里干活的 AI agent 看的工程约定。用户向的功能说明在 `README.md`，这里只写「怎么改、改完怎么验」。

## 一句话定位

面向信息学奥赛（OI）教学的 **VS Code 扩展**：从洛谷抓题建文件并拉样例、本地样例评测、提交代码到洛谷、
把代码导出成 PNG、在题面上用数位笔画批注并导出 A4 图片、把板书与 AC 代码整理成 Typst 题解 PDF。
建题时还会调隔壁 `E:\BiliBiliHelper` 生成题目封面（见「题目封面」一节）。纯 TS，esbuild 打包，
无原生模块，一个 `.vsix` 通吃 Linux / macOS / Windows。

**与爱思创那版（`oi-teaching-assistant`）的关系**：本项目从它拆出。`whiteboard/` `judge/` `terminal/`
`imgexport/` `ui/` `problems/statement` 这一层是站点无关的通用层，整体搬了过来；
`src/asc/`（站点协议）、班测/班级文件那一整条链路全部删掉，换成了 `src/luogu/`。
两边**不要互相 import**，也不要指望合并回去 —— 各自演进。

## 常用命令

```bash
npm install
npm run typecheck   # 两个工程：tsc --noEmit -p ./ + -p tsconfig.webview.json
npm run build       # esbuild → dist/（非 production，带 sourcemap）
npm test            # esbuild.test.js 打包测试 → node --test test-dist/*.test.js
npm run test:smoke  # production build + node test/smoke-activate.cjs
npm run verify      # 上面三步串起来，本地交付前跑这个
npm run package     # typecheck + production build + smoke + vsce package
```

改完代码的最小验证是 `npm run verify`；只改了注释/文档也别省 typecheck。

## ⚠️ 洛谷站点契约：哪些已验证、哪些还没核对

**这是本项目最容易改错的地方，动 `src/luogu/` 之前先读这张表。**

| 契约 | 把握程度 | 备注 |
| --- | --- | --- |
| 读接口要带请求头 `x-lentille-request: content-only` + `Accept: application/json` | **已验证** | **`?_contentOnly=1` 这个查询参数已失效** —— 带上它也会退回整页 HTML。2026-10-12 实测 |
| 信封：payload 在 `data`（Lentille），旧的 `currentData` 已下线 | **已验证** | 两种都收，判据是「`data` 是不是非空对象」 |
| `GET /problem/<pid>` → `data.problem` | **已验证** | 公开接口，不登录可读。字段映射见 `problems/statement.ts` |
| 题面字段：标题是 `name`、正文在 `content`（`formatI`/`formatO`）、限制在 `limits` | **已验证** | 顶层 `title` 存在但是**空串**；平铺的 `description`/`memoryLimit` 已不存在 |
| `limits.time` 是**毫秒**、`limits.memory` 是 **KB** | **已验证** | 都是数组，取最大值。128MB 的题给 `memory:[131072]` —— 当字节算会差三个数量级 |
| 样例是 `[[输入,输出],…]` 元组数组 | **已验证** | 不是 `{input,output}` 对象 |
| `GET /problem/list?keyword=…` → `data.problems.result` | **已验证** | `result` 是数组还是以 pid 为键的对象，两种都收了 |
| `GET /_lfe/config` → `CodeLanguage` / `RecordStatus` 枚举 | **已验证** | 不登录可读。语言 id 与判定状态码的权威来源，见下 |
| `POST /fe/api/problem/submit/<pid>` 的请求体是 **JSON** | **已验证** | 2026-10-12 浏览器真机抓包：`content-type: application/json`。**不是** multipart 表单 |
| 提交要带 `X-Requested-With: XMLHttpRequest` + `Origin` | **已验证** | 浏览器自动加的，**Node 不会替你补** —— 漏了可能被鉴权挡 |
| CSRF 走 `x-csrf-token` 头，Referer 指向**题目页** | **已验证** | 抓包确认 `referer: /problem/P1001`。洛谷按页面发令牌，主页那个过不了鉴权 |
| 提交请求的 Cookie 里**也带 C3VK** | **已验证** | 抓包见 `C3VK=…`。所以 POST 也受反爬挑战约束 —— 这正是不敢自动重试 POST 的原因 |
| `lang` 是**数字**语言 id | **已验证** | 抓包 payload：`{"lang":11,…}`。11 = C++14，**不是** 12。别名表见 `client.ts` 的 `LANGUAGES` |
| `enableO2` 的取值（`0`/`1`） | **已验证** | 抓包 payload：`"enableO2":1`。浏览器 UI 默认**开着** |
| 提交 body 就是 `{lang, code, enableO2}` 三个键 | **已验证** | `content-length: 151` 与该 JSON 的字节数逐字节吻合 → 没有隐藏字段、没有 csrf 域 |
| 提交成功后返回 JSON `{rid}` | **已验证** | 2026-10-12 真机提交跑通；**不是** 302 跳 `/record/<rid>` |
| `GET /record/list?user=<uid>&page=1` → `data.records.result[]` | **已验证** | 登录探活走的就是它（真机登录成功） |
| **判定在 `record.status`（数字），不是 `judgeResult.verdict`** | **已验证** | 2026-10-12 真机提交跑通并显示判定。枚举取自站点 `/_lfe/config`。12=AC |
| ⚠️ `detail.judgeResult.status` **不能**当判定 | **已核对** | 实测那份 AC 记录里它给的是 `0`（Waiting）—— 取它会把 AC 显示成「等待中」 |
| `record.memory` 是 **KB**、`record.time` 是 **毫秒** | **已核对** | 与 `limits.memory` 同量纲；当字节算会差三个数量级 |
| CE 报错在 `detail.compileResult.message` | **已核对** | `verdict === "CE"` 时提交域会把它弹出来。**还没拿 CE 提交验过** |

> 上表「未核对」= 依据洛谷前端与公开文档推断、代码已按此实现，但**还没有真机证据**。
> 「已验证」才是抓包或真机跑通的。首次真机跑通后请回来把对应行改成「已验证」。

**2026-10-12 整条链路已在真机跑通**（抓 Cookie → 拉题面 → 提交 → 轮询判定，
首次真机提交拿到 **AC**）。还留着的两类尾巴：

- **CE 分支没验过** —— `detail.compileResult.message` 只在编译失败时才有内容，
  拿 AC 提交验不到。第一次遇到 CE 时确认一下报错有没有正常弹出来。
- **`record.memory` / `record.time` 的单位**是从一份第三方贴的响应推的（KB / 毫秒），
  真机提交时若界面上的时间/内存数值合理，就顺手把那行改成「已验证」。

交付前请勿改动下面这段已确认的事实（它们是这一轮反复核对出来的）：

2026-10-12 已确认的（浏览器真机抓包）：请求体就是 `{lang, code, enableO2}` 三个键，
`lang` 是数字 id（网页默认 **11 = C++14**，扩展的 `cpp` 别名也跟着它 —— **默认值刻意与网页一致**，
这样「网页能过、扩展不行」时能立刻排除语言版本这个变量），`enableO2` 是 0/1（网页默认 **1 = 开**，
扩展默认也跟着开，可通过 `lgAssist.submit.enableO2` 关），
CSRF 只走头、body 里没有 csrf 域，`Origin` 与 `X-Requested-With: XMLHttpRequest` 必须手动补。

**反爬挑战（C3VK）**：洛谷会先 302 跳回自身并下发 `Set-Cookie: C3VK=…; Max-Age=300; Path=/`，
带上重试才放行，**而且每次放行都会再换一枚新的码**（2026-10-12 真机撞到并已实现，
见 `client.ts` 的 `absorbChallenge` / `cookieHeader`）。**提交请求的 Cookie 里也带 C3VK**
（抓包实测），所以 POST 同样受这条约束。

这条有两个**很具体的坑**：

1. `http.ts` 不跟随重定向，所以未处理的 302 会被 `envelopeFull` 当成「登录态过期」——
   **报出来的是假原因**，用户会去重新粘 Cookie，而真正的问题是反爬挑战。
   新增请求路径时记得走 `call()` / `html()`（里面已经处理了挑战），别自己直接调 `request()`。
2. **POST 绝不能自动重试**。挑战是 302 自跳，看着无害，但提交接口有可能已经把记录建好、
   自动重放就变成**两条重复提交**。所以 `retryChallenge` 只有 GET 能开；提交改为
   「发之前先 GET 题目页把挑战码备好」（`csrfFor` 走的就是这条），真撞上就报给人手动再点。

**还有一类坑：浏览器自动加、Node 不会替你补的头**。抓包洛谷的提交请求可见
`Origin`、`X-Requested-With: XMLHttpRequest`、`Sec-Fetch-*` —— 前两个是鉴权相关的，
走 Node 时必须**手动补上**（见 `submit()` 的 headers）。只看请求体和响应就动手改代码，
很容易漏掉这一类。

核对方法（与爱思创那版同一条路子）：浏览器 F12 看提交请求的表单域与响应；
洛谷前端是打包后的 JS，可以直接搜调用点。**核对完请回来把结论补进这张表和
`src/luogu/client.ts` 顶部的注释。**

**2026-10-12 这一轮的教训**：`?_contentOnly=1`、`currentData`、multipart 表单、
302 跳 `/record/`、`lang: "cpp"`、`GET /user` 探活 —— **六条老假设里有六条是错的**，
而且全都写在「已验证」那一栏里。所以这张表的「已验证」只表示**真机跑通过**，
从文档或前端反推出来的一律标「已核对」。

**怎么核对才有效**：不必等人登录。凡是**请求形状**类契约，站点的公开面基本都能查 ——
`GET /_lfe/config` 给了全部枚举、`GET /_lfe/tags` 给了标签字典、公开接口带
`x-lentille-request: content-only` 头就能读 JSON。实测下来只有 `/record/*`
（未登录一律 401）和提交本身需要登录才能验。注意 `Invoke-WebRequest` 能拿到 200
不代表 Node 能拿到 —— 挑战码是跟客户端相关的，**最终要用 `node` + 扩展自己的 `http.ts` 验**。

已经定死、别改的两条：

1. **只有拿到判定文本才算终局结果**（`isFinalJudgeResult`）。洛谷评测是异步的，刚提交完去查会拿到
   「评测中」那条中间记录 —— 它的状态字段已经不是「等待」，只看它就会把中间态当结果显示。
   宁可多等一轮，也不要显示错的判定。
2. **判不出来就显示「未知」（`?`），不要猜**。`verdictFromStatus()` 只认
   `RECORD_STATUS` 表里核对过的数字码，不认识的码给 `?` **且不算终局**（继续等，
   而不是把可能的中间态当结果报出去）；表里的值一条一条都有出处，别凭印象加。
   （`RecordStatus` 枚举**已核对**：`-1` Unshown、`0` Waiting、`1` Judging 是中间态，
   2=CE、3=OLE、4=MLE、5=TLE、6=WA、7=RE、11=UKE、12=AC、14=NAC。）
3. **非 AC 判定要「连续两拍一致 + 留观」才报**（`app/submit.ts` 的 `pollResult`）。
   站点异步写回时顶层状态可能先落一个看起来像结论的值（典型是 WA），稍后才被真正的
   TLE 盖掉。所以拿到终局码先不报：AC/CE 直接报（稳定），其余留观
   `pollIntervalMs * 3` 且与上一拍**同一个判定**（`judgeSignature`）才认。
   **洛谷没有「验明正身」那一层**（爱思创那版用代码全文比对，本扩展按 rid 精确寻址，
   天然不会读到上一条提交），也**没有逐测试点判定的依据**（洛谷 `/record/<rid>` 的
   字段形状还没核对）—— 别把姊妹工程那两段照抄过来。
   每一拍都要往输出面板留一行 `[评测] 现场`：站点字段再变时，从日志就能看出当时给了什么。

**判定字段曾经踩过的坑**（2026-10-12 真机暴露）：早先照 `record.judgeResult.verdict` 读判定 ——
那两层都不存在，`rawStatus` 永远是空串，于是**每一次提交都一路轮询到 120 秒超时**，
界面上表现为「提交后等了很久没结果」。真实字段是 `record.status`（数字）。
教训：**字段名要真机核对**，别照「看起来合理」的路径写；而且当时若没有那条诊断日志，
这个错会一直表现为「网络慢」。

已经定死、别改的两条：

## 架构约定

- **站点访问一律走 `src/luogu/client.ts`**，不要在别处直接 `request()`：那里有串行节流
  （默认 ≥800ms，洛谷比一般 OJ 敏感）、统一的 `_contentOnly` 信封解析、以及登录态过期的统一转换。
- **纯逻辑模块不许 `import 'vscode'`**：`src/util.ts`、`src/problems/statement.ts`、
  `src/problems/uploadName.ts`、`src/luogu/multipart.ts`、`src/luogu/contract.ts`、`src/judge/diagnostics.ts`、
  `src/banshu/template.ts`、`src/banshu/typst.ts`、`src/cover/spec.ts`、`src/cover/cli.ts`、
  `src/ui/layout.ts`、`src/ui/theme.ts`、`src/whiteboard/model.ts`、`src/whiteboard/fontCss.ts`。
  它们被 `test/` 直接引用，混进 vscode 依赖会让单元测试整体跑不起来。文件头有相应注释。
  （`src/luogu/client.ts` 因为经 `../config` 间接引到 vscode，**引不进单测** ——
  所以站点契约的纯逻辑一律放 `src/luogu/contract.ts`，`client.ts` 再导出一次。）
- **webview 侧的代码不许（直接或间接）引到 `vscode`**：`src/whiteboard/webview.ts` 由 esbuild 的
  **第二入口**打成浏览器 iife（`dist/whiteboard.js`，面板读文件内容内联进 HTML 走 nonce）。
  浏览器那次打包没有 `external: ["vscode"]`，一旦间接引到就会打包失败。它因此**不在主 tsconfig 里**，
  由 `tsconfig.webview.json`（带 DOM lib）单独 typecheck —— 改 `src/ui/*` 时注意别顺手 import 'vscode'
  进 `theme.ts` 这种两边共用的模块（`BASE_STYLE` 就放在 theme.ts 正是这个原因）。
- **编排集中在 `src/app/`**：`src/app/index.ts` 的 `App` 是命令编排的 façade，`src/extension.ts` 只做注册
  （统一的 try/catch 与错误上报也在那段 `register` 包装里，不要绕过）。控制器共享 `base.ts` 的 `Controller`
  （依赖快捷方式 + `requireLogin`/`reportError`/`refreshCurrentRef` 等共用小工具）。
  **控制器之间不许互相 import**：跨域调用一律经 `PeerHost` 回到 `App`（`base.ts` 定义该接口，
  `App` 实现它），否则这几个流程立刻长出环。纯函数型的共用逻辑放控制器之外的 `authOps.ts` /
  `judgeOps.ts`。
- **命名空间是 `lgAssist.`**：视图类型、状态键（`lgAssist.whiteboard.*`）、诊断集合名、设置项前缀、
  命令 id 全都用它。**别改回 `oiAssist.`** —— 两个扩展会同时装，撞了状态键和命令 id 就是灾难。
- **导出/渲染要保持「屏幕所见 == 导出所得」**：纸张样式只有一份 `SHEET_RULES`（`src/whiteboard/model.ts`），
  屏幕与导出 SVG 共用；导出时 `--vscode-*` 变量不存在，所以覆盖样式必须写完整声明（如 `border: 1px solid …`），
  只写 `border-color` 是补不回边框的。
- **面板的视觉语言是「竞赛记分牌」，token 在 `BASE_STYLE` 里**：判定色（`--oi-ac` / `--oi-wa` / `--oi-tle` /
  `--oi-re`）、等宽数据字体（`--oi-num`）、淡底纹（`--oi-tint`）、`.mono` / `.oi-grow` / `.oi-rule` / `.oi-chip`。
  几条别推翻的取舍：
  - 判定色用 `color-mix(色相 88%, var(--vscode-editor-foreground))` 让明度跟着主题走，不要维护深浅两套值。
  - **RE 是紫色不是棕色**：棕色和 TLE 的黄在小色块上分不开。
  - 判定色只出现在 3px 竖条和小色块上，不做大面积填充 —— 投影时整片红绿刺眼。
  - 样例保持 `<details>` 渐进披露、默认收起：老师多数时候只看结论那一行。
  - 侧边栏是 `TreeView`，样式由 VS Code 主题接管，**改不了**，别往那儿加 CSS 方案。
- **站点访问的唯一例外是白板导出**：那里由扩展进程读盘把 KaTeX 字体转 base64 内联，不走 HTTP。
- **HTTP 请求要传 keep-alive 的 `agent`**（`src/luogu/http.ts`）：globalAgent 的 `keepAlive`
  是 Node 19 才默认打开的，而 VS Code 自带的 Electron 是 Node 18 —— 不显式传就是每次请求
  重做 DNS+TCP+TLS。轮询评测每 2 秒一次，一次提交能轮询到 30 次。
  `maxSockets` 给 5（不给 1：登录探活与排队请求会互等）。
- **本地评测的样例是有界并发跑的**（`judge/judge.ts` 的 `judgeConcurrency` / `mapBounded`）：
  并发度 `clamp(核数-1, 1, 4)`，**结果按输入顺序回填**（`CaseResult.index` 与面板编号靠它）。
  别改回串行：等待时间是按样例数线性放大的（10 个样例 × 10 秒限时 = 100 秒）。

## 几处「看起来是小 bug、实际会咬人」的地方（2026-10-21 修，别改回去）

这四条都是洛谷版自己踩出来的，测试已经钉住：

- **提交锁必须在函数入口上**（`app/submit.ts`）。早先是「检查 `submitting` 在前、置位在真正发请求前」，
  中间隔着读文件、定位题目、提交前编译三个 await —— 连点两次提交两次都能过检查，
  站点上就多出一条重复记录。洛谷的 POST 明确**绝不能自动重试**，重复提交比一次失败更难收拾。
- **题解 `.typ` 的写入：文档在编辑器里开着时走 `WorkspaceEdit`，别直接改盘**。
  直接 `fs.writeFileSync` 会和老师未保存的改动打架 —— 缓冲区里那份才是「活」的，
  磁盘上刚写的会被他下一次保存覆盖回去，症状是「点了没反应，题解里还是老的」。
  文档没开时仍然直接改盘（省得把它开成脏文档）。
- **样例的 `.in` 文件：输入为空但输出非空时也要落一个（空）`.in`**。
  `judge/judge.ts` 的 `discoverSamples` 只按 `^<题号>_(\d+)\.in$` 发现样例，
  只写 `.out` 的话这种样例**永远不会被评测** —— 洛谷「输出一个数字」那种空输入样例真实存在。
  反过来 `.out` 缺失的语义是「只运行不判定」，那个要保留。
- **题号要同时清洗目录名与文件名**（`problems/files.ts` 的 `sanitizeDirName`）。
  题号来自用户的输入框（校验只挡了空白），`../foo` 这种题号能把目录甚至文件写到题库外面。
  正常题号（`P1001` / `CF1A` / `AT_abc001_a`）清洗后是恒等变换，不影响既有工作区。
  另：**板书图宽度这个设置要清洗**（`banshu/template.ts` 的 `banshuImageWidth`）——
  它是原样拼进 Typst 源码的，一个坏字符就让整份 PDF 编译不过。

## 登录态的边界

- 洛谷登录带验证码，扩展里**做不了自动登录，也没有静默重登**。唯一入口是「粘贴 Cookie」。
- **粘进来的形状五花八门，一律用 `parseCookieInput` 归一化**：整条 `Cookie:` 请求头、
  只有值、一段一段每行一条、F12 里折的行、等号带空格、多个堆一起带空行 —— 全要认。
  少认一种就是「用户明明贴对了却登不进去」。
- ⚠️ **判登录态看 `_uid` / `__client_id`，不看 `csrf_token`**。洛谷真实会话里**没有**
  `csrf_token`（真机抓包 `Cookie: _uid=…; __client_id=…; C3VK=…`）。早期版本拿
  `csrf_token` 当必要条件，等于登录永远走不通。CSRF 走的是**题目页**下发的令牌（`csrfFor`）。
- **Cookie 只进 `SecretStorage`**，绝不写 `globalState` / `workspaceState` / 任何文件。
  `luogu/session.ts` 里探活失败要**连同密钥库里那份一起删掉**。
- 题面、搜索以外的本地功能（编译、评测、白板、图片导出）**都不要求登录**。
  别给它们加 `requireLogin()` —— 那是把「能读题」变成「必须登录」的无谓门槛。

## 测试分工（两层，别搞混）

| 层 | 位置 | 覆盖什么 |
| --- | --- | --- |
| 纯逻辑 | `test/*.test.ts` + `test/vscode-stub.ts` | 输出比较、判定归一化、题号识别、题面字段映射与单位换算、编译报错解析、终端命令拼装、白板纸张排版 |
| 冒烟 | `test/smoke-activate.cjs` | 真实加载 `dist/extension.js`、真实 g++ 编译与跑样例、渲染评测/图片/白板面板并断言载荷 |

冒烟测试会 **mock 掉 `vscode` 模块**（`Module._load` 拦截），所以它同时是「模块图能不能加载」的守门人。
它有三个硬断言，改代码时最容易踩：

1. `package.json` 里 `contributes.commands` 声明过的命令 **必须**都在 `extension.ts` 里注册了
   —— 加命令要同时改两处，否则冒烟直接红。
2. 面板 HTML 必须带 CSP、内联脚本必须走 nonce、`script-src` 不能放开 `unsafe-inline`。
3. 命令 id 前缀必须是 `lgAssist.`。

冒烟测试需要 `g++` 在 PATH；没有时它不会自动跳过（单元测试里带 `skip: !hasGpp` 的用例会跳过）。

## 写跨平台测试的约定（踩过）

- 断言绝对路径用 **`path.resolve`**，不要用 `path.join` —— 产品代码用 `path.resolve` 拼相对路径，
  Windows 上会带上当前盘符，`path.join("/tmp/x","a.cpp")` 得到的是 `\tmp\x\a.cpp`，必红。
- 断言可执行文件名用 **`exeNameFor(stem)`**，不要写死有无 `.exe`。
- 带平台分支的函数（`cacheRoot` / `exeNameFor` / `detectExternalTemplate` / `isCmdShell` /
  `clearCommand` / `exitSuffix` / `sameFilePath`）都接受 `platform` 参数，测试要显式传，别依赖当前机器。
- ⚠️ **`platform` 参数要同时管「大小写」与「路径解析语义」**（2026-10-25 踩过，差点把 CI 弄红）。
  只让参数管大小写、解析仍用运行时的 `path.resolve` 的话：在 Windows 上 `C:\a\..\b` 会归一成
  `C:\b`，可到了 Linux 上 `path.resolve` 把 `C:\a\..\b` 当成**一整个文件名**（POSIX 里反斜杠
  不是分隔符），`..` 就不归一了 —— 同一条断言**本机过、ubuntu CI 红**。
  所以这类函数要用 `path.win32.resolve` / `path.posix.resolve` 按平台选（`util.ts` 的
  `sameFilePath` 就是这么写的）。CI 跑在 ubuntu 上，这类差异本地发现不了。
- **别断言构建产物**（`dist/`、`test-dist/`）：`npm test` 跑在 build 之前，CI 上更是全新 checkout，
  断言产物必然又红又飘。断言源码与配置。

## 题解板书（Typst，动这层前先读这两条坑）

把一道题的**板书图 + AC 代码**整理成一页 Typst 题解并导出 PDF。落的目录是扩展自己的题目录
（`<工作区>/<题目根目录>/<题号>/`），产物：`题解板书.typ`、`<题号> 板书.png`、
`<题号>_AC.cpp`、`题解板书.pdf`；共享版式 `banshuconf.typ` 在题库根目录**一份**。

- **跨目录 import 必须带 `--root`**：题解用 `#import "../banshuconf.typ"` 引共享版式，
  而 Typst 默认把「被编译文件所在目录」当项目根，不带 `--root` 会直接报
  `would escape the project root`（2026-10-12 实测）。编译时 `--root` 放宽到工作区。
- ⚠️ **Typst 的 `read()` / `image()` 路径按「写这行字的那个文件」解析，不是按调用处**。
  所以**别在 `banshuconf.typ` 里放 `codefile(path)` 这种「读同目录文件」的 helper** ——
  它会去题库根找文件（实测报 `file not found (searched at <root>/x_AC.cpp)`）。
  贴代码要在**题解文档里**直接写 `#raw(read("P1395_AC.cpp"), lang: "cpp", block: true)`。
  `test/banshu.test.ts` 有两条测试专门守这个。

扩展只替换 `// >>> lgAssist:image` / `// >>> lgAssist:code` 标记**之间**的内容，
标记之外的（老师手写的说明）不会被自动写入碰掉 —— 改这两段逻辑时别把标记语义弄丢。

## 题目封面（联动 BiliBiliHelper）

建题时调隔壁项目 `E:\BiliBiliHelper`（洛谷题解封面生成器，Python）渲染一张封面，落到**题目录**里：
`<题目录>/<题号> 封面.png`。三层分工：`src/cover/spec.ts`（文件名 + argv，**纯逻辑**）→
`src/cover/cli.ts`（起进程，同样不 import 'vscode'）→ `src/app/cover.ts`（编排）。两边**不互相 import**，
只通过对方的 CLI 打交道（`bili-helper cover <题号> -o <图>`）。

改之前先读这四条（前两条是真机踩出来的）：

1. ⚠️ **必须给子进程 `PYTHONIOENCODING=utf-8`**。Windows 上 Python 的 stdout 走管道时按本地代码页
   （中文系统 cp936）编码，我们按 utf8 读就是乱码 —— `[ok] 已生成封面：…` 变成 `[ok] �����ɷ��棺…`。
   图其实已经出来了，但日志看着像失败。对方 CLI 只 `reconfigure(errors="replace")`、不动编码，
   所以只能由调用方指定（见 `cli.ts` 里 `execFile` 的 `env`）。
2. ⚠️ **`python -m bili_assistant.cli` 需要 cwd 落在 BiliBiliHelper 项目根**，否则
   `ModuleNotFoundError: No module named 'bili_assistant'`。cwd 来自 `lgAssist.cover.projectDir`；
   用 venv 里的 `bili-helper.exe` 时不需要它。默认命令是 `bili-helper`（**本机没装在 PATH 上**，
   所以真机上要按 README「题目封面」那节配 `command`/`args`/`projectDir`）。
3. **自动流程在界面上完全静默**（`loud=false`），且调用方**不 await**（`void this.host.ensureCoverImage(...)`）。
   一次渲染约 3–7 秒，建题后老师要的是源文件立刻打开；`ensure()` 内部吞掉所有异常，别把它改成会抛的
   写法 —— 那是未处理的 rejection。**连「正在生成封面…」的进度通知都不给**：`.vsix` 里装不下
   BiliBiliHelper，所以**多数学生机器上命令是找不到的**，命令会立刻失败，闪一下的通知比不提示更让人困惑。
   找不到命令时只往输出面板写日志（完整说明每会话一次，之后一句短行）。只有手动命令
   （`lgAssist.createCover`）才包 `withProgress` 并弹框 —— 那是用户主动要的。
   `enabled` 默认 `true`（老师机器开箱即用），学生机无感跳过，别按「学生没装就默认关掉」改。
4. **已存在就跳过**，重渲染走手动命令。文件名模板（`lgAssist.cover.fileName`，`${id}` 换题号）与
   封面**设计**模板（`--template series/dark-tech/minimal`）是两回事 —— 曾经合用一个字段，
   于是换个画面风格会连文件名一起变，「已存在就跳过」当场失效（`test/cover.test.ts` 钉住了这条）。

产物与题解目录里既有的 `<题号> 板书.png` 同一套命名；封面**不**写进 `题解板书.typ`
（那个图片块是白板导出的板书图，别混）。

模板**只放板书图 + 代码实现两块**，不预置「题意理解/思路/复杂度分析」那些小节
（板书图里已讲完，正文重复没意义）。但常用组件 `note/tip/warn/chip/divider` 已经
默认 import 好 —— 否则想临时加个 `#tip[...]` 会先撞一次 `unknown variable`。

## 平台注意

- **Windows**：编译产物必须带 `.exe`（`exeNameFor`）；集成终端带输入重定向时固定用 `cmd`
  （PowerShell 不支持 `<`）。中文路径在英文区域设置（非 UTF-8 代码页）下 MinGW 会拿到 `?`，README 有说明。
- **编译产物落在缓存目录**（`~/.cache/oi-assistant/build/<目录哈希>/`，Windows 走 `%LOCALAPPDATA%`），
  不要改成写到源文件旁边。

## 白板与手写笔（这层最费过功夫，改之前务必读完）

白板与手写笔的约定**整条继承自爱思创那版**，那边每一条都是真机复现后定下来的，不要凭直觉"优化"：

- **白板的默认笔色/笔宽是红 + 细**（`DEFAULT_PEN_COLOR = PENS[1]`、`DEFAULT_STROKE_WIDTH = PEN_WIDTHS` 的
  「细」0.6，`src/whiteboard/model.ts`）。讲义是投影用的，红笔写重点、黑色留给题面本身。别"顺手改回"黑色或中档。
- **数位笔/压感**：笔迹走 Chromium 的 Pointer Events —— `pointerType === "pen"` 时 `event.pressure`
  才是真实笔压，鼠标恒为 `0.5`，所以鼠标画出来必然是等宽线。变宽笔迹用 `perfect-freehand`，
  参数抄 Excalidraw（`size = 笔宽 × 4.25`、`thinning 0.6`、`smoothing 0.5`、`simulatePressure: false`）；
  高回报率的笔要遍历 `getCoalescedEvents()` 取点，否则会画成折线。别照 Excalidraw 那套「鼠标按速度模拟压感」。
- **笔尖指示器必须自己画**：数位笔一接触，Chromium 就把系统鼠标光标藏起来（抬笔才回来），
  所以 `pointerType !== "mouse"` 时给视口加 `.wb-pen-cursor`（`cursor: none`）并由 canvas 画
  空心圈 + 笔杆（圆心＝笔尖＝笔迹落点；实心会盖住刚写的笔迹；笔杆朝**右上方**，与握笔姿势一致）。
  另外：**悬停（不接触）移动原本不重绘**，要让指示器跟手就得在 `!inContact` 那条分支里补一次 `schedule()`。
- **白板重绘走 `FrameLoop`（`src/whiteboard/frameLoop.ts`），不要退回单个布尔的 rAF 闩**：
  webview 被冻结时排队中的 rAF 回调会被丢掉，闩合不上就会让画布永久冻住。
  提交点（一笔画完 / 撤销 / 清空）用 `flush()` 直接画。
- **笔迹重绘的三条流畅度约定**：① 正在写的这一笔轮廓**每帧至多重算一次**；② 已提交的笔迹走**离屏缓存**，
  每帧只 `drawImage` 一次，只有「笔迹集合变了 / 视角变了 / 画布尺寸变了」才重画它 —— 这三处漏一个就是
  「笔迹突然不见了」；③ `#ink` 用 `will-change: transform` 单独提一层。
- **白板的指针输入按「接触状态」驱动**（`PointerEvent.buttons & 1`），不要用「pointerId 是否匹配」决定要不要继续画：
  数位笔中途掉序列会把后半截 move 整段吞掉，症状是「一条笔画只画出开头一段」。
  配套：仍带接触的 `pointerup` 要忽略、还压着时 `lostpointercapture` 要续画、贴近笔尾的重复 pointerdown 当同一笔、
  失焦/无接触离开视口/下次 pointerdown 兜底收尾。
- **工具栏的「笔迹 N」是输入链路的探针**：数字不涨 = 输入层丢事件，涨了没墨 = 重绘层。
- **白板上的题面 DOM 必须对指针「隐身」**：CSS 关掉 `user-select` / `-webkit-user-drag`，
  `.oi-sheet-body` 设 `pointer-events: none`，`webview.ts` 再用捕获阶段的 `dragstart` / `selectstart` 兜一道。
  原因：原生拖拽一启动，Chromium 会终止整条指针序列（`pointercancel`），症状是「笔走一小段就断、必须抬笔重落」。
  所以 `pointercancel` 必须**单独处理**。工具栏探针 `笔迹 N · 断流 N · 取消 N · 拦手势 N` 是分流依据。
- **白板工具栏的功能键是图标，且整条 `overflow-x: auto` 不折行**：分屏后面板只剩几百像素，
  中文按钮名会在按钮**内部**折成两行。图标按钮固定 26px（`.wb-icon`，内联 SVG + `title` 提示）。
  DOM 里把 `wb-zoom` / `wb-export` 排在三个诊断计数**之前**，计数里只有 `#wb-stats` 不许收缩。
- **导出 A4 PNG**：题面 DOM 经 SVG `foreignObject` 栅格化（KaTeX 字体由扩展进程读盘、转 base64 内联）。
  **字体只打包 woff2**（约 254 KB），`.woff`（296 KB）与 `.ttf`（502 KB）**没有任何消费者**
  （`esbuild.js` 的 `copyKatex()` 逐个文件拷、按扩展名过滤）。别改回整目录拷贝 ——
  那会让每个 `.vsix` 多背约 800 KB 死重。`test/whiteboard.test.ts` 守着这条。
  **量内容高前必须先把 `#sheet` 的 `min-height` 摘掉**，否则整页高的 `scrollHeight` 取整后会凭空多出一页。
  导出尺寸默认 150dpi（1240×1754），由 `lgAssist.whiteboard.exportDpi`（72–600）决定。
  **改导出相关代码后请真机看一眼导出图** —— 冒烟测试覆盖不到。
- ⚠️ **题面里的网络图片必须先内联成 data URI**（`src/whiteboard/remoteImage.ts`）。
  SVG 当 `<img>` 加载时浏览器**不取外部资源**（KaTeX 字体也是因此才专门内联），
  不做这步就是「屏幕上有图、导出的 PNG 里是空白」—— 洛谷题面常带示例图，讲义缺图很明显。
  流程：webview 收集 `#sheet` 里的 `http(s)` 图片 → 扩展进程下载（`inlineRemoteImages`，
  单张 ≤8MB / 整批 ≤20MB / 最多 20 张 / 魔数嗅探）→ 回传 `url → data URI` →
  webview 替换 `src` 并去掉 `srcset` → 才序列化。**顺序不能反**（先内联再序列化）。
  任何一张失败只跳过那一张，不挡导出。
- **改 `BASE_STYLE` 会顺带改到导出纸张**，字号一变就可能多出一页。所以**纸面可见的排版参数一律在
  `SHEET_RULES` 里显式写死**，别让它继承。改这些参数时注意**方向**：调小只会让页数变少或不变，
  调大才可能凭空多出一页。

2026-10-10 在 HUION Q620M + Win11 上真机实测通过（压感、缩放、导出公式与批注都正常），
所以这条路径是**已验证可行**的，别因为「foreignObject 风险高」去改架构。

## 发布

```bash
npm run package     # 产出 luogu-teaching-assistant-<version>.vsix
```

`package.json` 的 `version` 改动后，记得同步 `README.md`「安装」一节里写死的 vsix 文件名。

**装到本机做真机验证前先升版本号**：装同版本的 vsix 时 VS Code 可能当成「已安装」而不换文件，
于是「代码明明改了、界面还是旧的」。装完别只信 `successfully installed`，比一下安装目录里
`dist/extension.js` 的字节数与本地 `dist/` 是否相等（相等才算装的就是这份），然后让用户 **Reload Window**。

**打包过滤看 `.vscodeignore`，不看 `.gitignore`**：想把某个目录踢出 `.vsix`，
必须写进 `.vscodeignore` —— 只写进 `.gitignore` 不生效。

## 安全约束

- 洛谷 Cookie（会话凭据）只进 VS Code `SecretStorage`，**不要**写进 `globalState` / `workspaceState`
  或任何文件。
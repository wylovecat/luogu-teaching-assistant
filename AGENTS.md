# AGENTS.md — 洛谷教学助手

给在这个仓库里干活的 AI agent 看的工程约定。用户向的功能说明在 `README.md`，这里只写「怎么改、改完怎么验」。

## 一句话定位

面向信息学奥赛（OI）教学的 **VS Code 扩展**：从洛谷抓题建文件并拉样例、本地样例评测、提交代码到洛谷、
把代码导出成 PNG、在题面上用数位笔画批注并导出 A4 图片。纯 TS，esbuild 打包，无原生模块，
一个 `.vsix` 通吃 Linux / macOS / Windows。

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
| `GET /problem/<pid>?_contentOnly=1` → `currentData.problem` | 已验证 | 公开接口，不登录可读。字段映射见 `problems/statement.ts` |
| `memoryLimit` 是**字节**、`timeLimit` 是**毫秒** | 已验证 | 内存直接显示会差三个数量级，换算在 `statementFromLuogu` 里 |
| `GET /problem/list?keyword=…&_contentOnly=1` → `currentData.problems.result` | 已验证 | `result` 是数组还是以 pid 为键的对象，两种都收了 |
| `GET /user?_contentOnly=1` → `currentData.user` 探活 | 已验证 | |
| `POST /fe/api/problem/submit/<pid>` 的表单域 | ⚠️ **未核对** | 现按 `csrf_token` / `lang` / `enableO2` + 文件域 `code` 组包 |
| 提交成功后 302 的 `Location` 形如 `/record/<rid>` | ⚠️ **未核对** | 取不到 rid 时会把响应原文截一段抛出来，方便一眼看出是哪一类失败 |
| `GET /record/<rid>?_contentOnly=1` 的判定文本在 `judgeResult.verdict` | ⚠️ **未核对** | |
| 提交表单的 `lang` 取值（默认 `cpp`） | ⚠️ **未核对** | 以站点提交框实际选项为准 |

核对方法（与爱思创那版同一条路子）：浏览器 F12 看提交请求的表单域与响应；
洛谷前端是打包后的 JS，可以直接搜调用点。**核对完请回来把结论补进这张表和
`src/luogu/client.ts` 顶部的 TODO。**

已经定死、别改的两条：

1. **只有拿到判定文本才算终局结果**（`isFinalJudgeResult`）。洛谷评测是异步的，刚提交完去查会拿到
   「评测中」那条中间记录 —— 它的状态字段已经不是「等待」，只看它就会把中间态当结果显示。
   宁可多等一轮，也不要显示错的判定。
2. **判不出来就显示「未知」（`?`），不要猜**。`poll()` 只认 `judgeResult.verdict` 这一个文本字段，
   拿不到就 `verdict: "?"`；不要引入没核对过的数字状态码映射表。

## 架构约定

- **站点访问一律走 `src/luogu/client.ts`**，不要在别处直接 `request()`：那里有串行节流
  （默认 ≥800ms，洛谷比一般 OJ 敏感）、统一的 `_contentOnly` 信封解析、以及登录态过期的统一转换。
- **纯逻辑模块不许 `import 'vscode'`**：`src/util.ts`、`src/problems/statement.ts`、
  `src/problems/uploadName.ts`、`src/luogu/multipart.ts`、`src/judge/diagnostics.ts`、
  `src/ui/layout.ts`、`src/ui/theme.ts`、`src/whiteboard/model.ts`、`src/whiteboard/fontCss.ts`。
  它们被 `test/` 直接引用，混进 vscode 依赖会让单元测试整体跑不起来。文件头有相应注释。
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

## 登录态的边界

- 洛谷登录带验证码，扩展里**做不了自动登录，也没有静默重登**。唯一入口是「粘贴 Cookie」。
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
  `clearCommand` / `exitSuffix`）都接受 `platform` 参数，测试要显式传，别依赖当前机器。
- **别断言构建产物**（`dist/`、`test-dist/`）：`npm test` 跑在 build 之前，CI 上更是全新 checkout，
  断言产物必然又红又飘。断言源码与配置。

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
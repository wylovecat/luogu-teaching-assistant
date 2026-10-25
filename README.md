# 洛谷教学助手（luogu-teaching-assistant）

面向信息学奥赛（OI）教学的 VS Code 扩展：**从洛谷抓题建文件并拉样例、本地样例评测、把代码提交到洛谷题库、
在题面上用数位笔画批注并导出 A4 图片**。

纯 TypeScript，esbuild 打包，无原生模块，一个 `.vsix` 通吃 Linux / macOS / Windows。

> 本项目从 OI教学助手（`oi-teaching-assistant`）拆出：白板 / 评测 / 图片导出 / 题面渲染那一整层是
> 站点无关的通用层，直接搬了过来；站点协议层换成了洛谷。爱思创那版（`oi-teaching-assistant`）**继续独立维护**，
> 两个扩展可以同时装，各用各的命名空间（`lgAssist.` / `oiAssist.`）。

## 功能

| 功能 | 说明 | 需要登录 |
| --- | --- | --- |
| 一键编译运行 | `F6` 编译当前文件并在终端运行 | 否 |
| 样例评测 | `Ctrl+F6` 用题面样例本地评测，逐组给出 AC/WA/TLE/RE，编译错误带行列可点击跳转 | 否 |
| 抓题建题 | 按题号或搜索题库，建 `.cpp` + 样例 `.in/.out` + 题面 `.md` | 搜索需要 |
| 题面面板 | 内置面板渲染题面（KaTeX 公式），可复制样例、另存 Markdown | 否 |
| 题面白板 | 在题面上用数位笔批注，导出 A4 PNG | 否 |
| 知识面板 | 空白 A4 纸，用来讲知识点，导出 A4 PNG | 否 |
| 题解板书 | 建题时铺好 Typst 题解文档，板书图 + AC 代码自动整理，一键导出 PDF | 否 |
| 题目封面 | 建题时调 `BiliBiliHelper` 生成封面，落在题目录里（见 [题目封面](#题目封面联动-bilibilihelper)） | 否 |
| 代码导出 PNG | 把当前文件渲染成带语法高亮的图片，面板里 `A−`/`A＋` 调字号 | 否 |
| 代码字号 | `Ctrl+Alt+=` / `Ctrl+Alt+-` 放大/缩小**编辑器里**的代码字号（只动代码，不整窗缩放） | 否 |
| 笔迹稳定器 | 数位笔手抖大时开着，抹掉抖动但保留拐角（默认关，见 [笔迹稳定器](#笔迹稳定器)） | 否 |
| 提交洛谷 | 提交当前文件到洛谷并轮询评测结果 | 是 |

**洛谷题面是公开接口**，所以不登录也能读题、建文件、跑本地评测、白板批注；只有**搜索题库**与**提交**需要登录。

### 笔迹稳定器

数位笔的原始事件里混着手抖和板子的量化噪声，直接画出来线条发毛、慢写时有锯齿。
`lgAssist.whiteboard.stabilize` 打开后，这一层会做成**输入滤波**（思路抄 Xournal++）：

| 档位 | 效果 |
| --- | --- |
| `off`（默认） | 不滤波，与没装这一层逐点相同 |
| `light` | 抹掉手抖，笔画拐角保持原样 |
| `medium` | 滤波更强，慢写更顺，笔尖略微滞后 |
| `strong` | 手抖明显或写大字时用，落墨滞后最明显 |

三个要知道的取舍：

- **默认关**。任何平均都会让落墨比笔尖滞后约半个缓冲，写快了能看出来，所以只能由你主动开。
- **拐角不会被抹圆**：笔尖一折返就把那一小段原样交出去 —— 讲题时要圈的「这里要开 long long」不会变成圆弧。
- **改设置要重开白板面板**才生效；已经写下的笔迹不会被重新处理（当时写下的形状就是最终形状，导出也不变）。

## 安装

从源码打包：

```bash
npm install
npm run package     # 产出 luogu-teaching-assistant-<version>.vsix
code --install-extension luogu-teaching-assistant-<version>.vsix
```

装完请 **Reload Window**。验证装的是不是这份代码：比对 `dist/extension.js` 与
`%USERPROFILE%\.vscode\extensions\lgassist.luogu-teaching-assistant-<version>\dist\extension.js` 的字节数。

## 题目封面（联动 BiliBiliHelper）

建题时扩展会自动调 **BiliBiliHelper**（洛谷题解封面生成器）渲染一张封面，落到这道题的题解目录里：

```
题库/P1001 A+B Problem/
  P1001.cpp
  P1001.md
  P1001 封面.png          ← 自动生成（题号、题名、难度、标签、署名都由 BiliBiliHelper 拉/排版）
  题解板书.typ
```

- **已存在就跳过**，所以重复建题不会重渲染。想换一张：命令面板运行「生成题目封面（BiliBiliHelper）」。
- **失败不影响建题，界面也不打扰**：它在后台跑（一次约 3–7 秒），出错只写进「洛谷教学助手」输出面板 ——
  不弹框、不给进度通知。
- 生成用的是 BiliBiliHelper 自己 `config.toml` 里的系列名/模板/配色 —— 也就是说，
  **在封面工作台里怎么配，这里就怎么出图**；本扩展只覆盖它没写死的那几项。

> **没装 BiliBiliHelper 的机器（比如发给学生的 vsix）**：这个功能会**静默跳过** ——
> 界面上什么都不弹，只在输出面板留一行「未找到封面生成命令」。建题、编译、评测、白板全都不受影响，
> 所以**发给学生的那份 vsix 不需要为它做任何事**。想让日志也消失，把 `lgAssist.cover.enabled`
> 设成 `false` 即可。

### 配置

封面命令默认找 PATH 上的 `bili-helper`。两种常见装法二选一：

**A. 有 console script（`pip install -e .` 到 venv，直接用它的 exe）**

```jsonc
{
  "lgAssist.cover.command": "C:\\path\\to\\BiliBiliHelper\\.venv\\Scripts\\bili-helper.exe"
}
```

**B. 用 Python 跑源码（没装 console script，或想固定用某个解释器）**

```jsonc
{
  "lgAssist.cover.command": "python",
  "lgAssist.cover.args": ["-m", "bili_assistant.cli"],
  "lgAssist.cover.projectDir": "C:\\path\\to\\BiliBiliHelper"   // 必须是项目根，否则 import 不到包
}
```

其余可选项（都留空 = 用 BiliBiliHelper 的默认）：`lgAssist.cover.template`（series / dark-tech / minimal）、
`lgAssist.cover.palette`（blue / purple / warm / dark）、`lgAssist.cover.size`（如 `1146x717`）、
`lgAssist.cover.fileName`（默认 `${id} 封面.png`）、`lgAssist.cover.extraArgs`（如 `["--ai-bg"]`，
AI 背景**按次计费**，且它自己会走缓存）、`lgAssist.cover.timeoutMs`。
不需要这个功能就把 `lgAssist.cover.enabled` 关掉。

> 前置条件只在 BiliBiliHelper 那一侧：装好它、并且 `python -m playwright install chromium` 跑过一次。

## 登录（洛谷）
洛谷登录带验证码，扩展里做不了自动登录，所以走**粘贴 Cookie**：

1. 点侧边栏的「登录洛谷账号」（或状态栏的账号项）；
2. 扩展会打开洛谷登录页，在浏览器里正常登录；
3. 回到 VS Code，点「粘贴 Cookie」；
4. 浏览器按 `F12` →「网络」→ 刷新 → 点任意一条请求 →「请求标头」里的 `Cookie:` 那一行，
   **整行复制**（从 `key=value` 开始，不带 `Cookie:` 这个词）粘回来。

Cookie 只存在 VS Code 的密钥库（`SecretStorage`）里，不写任何配置文件。
Cookie 过期后会提示重新登录 —— **没有静默重登**，洛谷这套登录机制不支持。

## 开发

```bash
npm run typecheck   # 两个工程：主 tsconfig + tsconfig.webview.json（白板 webview 单独一个）
npm run build       # esbuild → dist/（非 production，带 sourcemap）
npm test            # 单元测试（纯逻辑，不需要 VS Code）
npm run test:smoke  # production build + 激活冒烟（需要 g++ 在 PATH）
npm run verify      # 上面三步串起来，本地交付前跑这个
```

改动之前请先读仓库根目录的 `AGENTS.md` —— 里面记了这个项目的架构约定、白板/手写笔那几条踩过的坑，
以及**洛谷站点契约哪些已验证、哪些还没核对**。
（它不进 `.vsix`，所以这里不做链接：它是给改代码的人看的仓库内部文档。）

## 目录速览

```
src/
  luogu/          站点层（唯一访问 www.luogu.com.cn 的地方）
  app/            命令编排：judge / problems / board / submit / imageExport / banshu / cover
  problems/       题面字段映射、文件关联、建题落盘
  banshu/         题解板书：Typst 版式与文档模板、typst 编译调用
  cover/          题目封面：文件名/命令行拼装（纯逻辑）、调 BiliBiliHelper 的 CLI
  whiteboard/     白板模型 + webview（手写笔批注、A4 导出）
  judge/          本地编译与样例评测
  terminal/       编译/运行的终端命令拼装
  imgexport/      代码 → PNG
  ui/             题面面板、评测面板、侧边栏、主题
```
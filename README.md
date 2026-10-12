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
| 代码导出 PNG | 把当前文件渲染成带语法高亮的图片 | 否 |
| 提交洛谷 | 提交当前文件到洛谷并轮询评测结果 | 是 |

**洛谷题面是公开接口**，所以不登录也能读题、建文件、跑本地评测、白板批注；只有**搜索题库**与**提交**需要登录。

## 安装

从源码打包：

```bash
npm install
npm run package     # 产出 luogu-teaching-assistant-<version>.vsix
code --install-extension luogu-teaching-assistant-<version>.vsix
```

装完请 **Reload Window**。验证装的是不是这份代码：比对 `dist/extension.js` 与
`%USERPROFILE%\.vscode\extensions\lgassist.luogu-teaching-assistant-<version>\dist\extension.js` 的字节数。

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
  app/            命令编排：judge / problems / board / submit / imageExport / banshu
  problems/       题面字段映射、文件关联、建题落盘
  banshu/         题解板书：Typst 版式与文档模板、typst 编译调用
  whiteboard/     白板模型 + webview（手写笔批注、A4 导出）
  judge/          本地编译与样例评测
  terminal/       编译/运行的终端命令拼装
  imgexport/      代码 → PNG
  ui/             题面面板、评测面板、侧边栏、主题
```
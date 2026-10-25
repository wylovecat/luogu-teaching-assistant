/**
 * 「写设置写哪一层」的测试。
 *
 * 这条链路最容易出的错是**改了被盖住的那一份**：工作区里已经定过这个键，你却写进了用户设置，
 * 于是「点了 A＋，当场字号变了，重开面板又跳回去」。`config.ts` 的 `updateImageFontSize` /
 * `updateEditorFontSize` 因此先 `inspect` 看谁定过、改那一层，写不进去再逐层退回。
 *
 * 这里把真实 VS Code 的**分层语义**在 stub 里复现出来：通用层（global / workspace /
 * workspaceFolder）与语言专属层（`*LanguageValue`）分开给值 —— 真实 API 也是分开的，
 * 混起来就会让「工作区定过」和「cpp 定过」互相盖住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { updateEditorFontSize, updateImageFontSize } from "../src/config";
import {
  getConfigWrites,
  resetConfigInspects,
  resetConfigUpdateFailures,
  resetConfigWrites,
  setActiveTextEditor,
  setConfigInspect,
  setConfigUpdateFailure,
} from "./vscode-stub";

function setup(): void {
  resetConfigInspects();
  resetConfigWrites();
  resetConfigUpdateFailures();
  setActiveTextEditor(undefined);
}

// ── 代码图片字号（lgAssist.imageExport.fontSize） ────────────────────────

test("图片字号：没人定过这个键就写用户设置（全局层）", async () => {
  setup();
  await updateImageFontSize(18);
  const writes = getConfigWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, "imageExport.fontSize");
  assert.equal(writes[0].value, 18);
  assert.equal(writes[0].target, "Global", "没人定过就写用户设置");
});

test("图片字号：工作区里定过就改工作区那份（改被盖住的那份等于没改）", async () => {
  setup();
  setConfigInspect("imageExport.fontSize", { workspaceValue: 14 });
  await updateImageFontSize(20);
  const writes = getConfigWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, "Workspace", "工作区定过就该改工作区");
  assert.equal(writes[0].value, 20);
});

test("图片字号：工作区文件夹定过就改那一份", async () => {
  setup();
  setConfigInspect("imageExport.fontSize", { workspaceFolderValue: 14, workspaceValue: 16 });
  await updateImageFontSize(22);
  const writes = getConfigWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, "WorkspaceFolder", "工作区文件夹层优先级最高");
});

test("图片字号：这一层写不进去就退回下一层（单文件夹工作区写 WorkspaceFolder 会抛）", async () => {
  setup();
  setConfigInspect("imageExport.fontSize", { workspaceFolderValue: 14, workspaceValue: 16 });
  setConfigUpdateFailure("WorkspaceFolder");
  await updateImageFontSize(24);
  const writes = getConfigWrites();
  assert.equal(writes.length, 1, "失败的那次不该被记成一次成功写入");
  assert.equal(writes[0].target, "Workspace", "写不进去要退回工作区层");
  assert.equal(writes[0].value, 24);
});

test("图片字号：值先清洗再写（设置项里手写 999 也不能写进去）", async () => {
  setup();
  await updateImageFontSize(999);
  assert.equal(getConfigWrites()[0].value, 32, "越界值要夹到上限");
  resetConfigWrites();
  await updateImageFontSize(Number.NaN);
  assert.equal(getConfigWrites()[0].value, 14, "非法值回落默认档");
});

test("图片字号：所有层都写不进去时要报错，不能静默吞掉（症状是「点了没反应」）", async () => {
  setup();
  setConfigUpdateFailure("Global");
  await assert.rejects(() => updateImageFontSize(18), /模拟写入失败|写入设置失败/);
});

// ── 编辑器字号（VS Code 自己的 editor.fontSize） ──────────────────────────

test("编辑器字号：没人定过就写用户设置", async () => {
  setup();
  await updateEditorFontSize(18);
  const writes = getConfigWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].section, "editor");
  assert.equal(writes[0].key, "fontSize");
  assert.equal(writes[0].value, 18);
  assert.equal(writes[0].target, "Global");
});

test("编辑器字号：工作区里定过就改工作区那份", async () => {
  setup();
  setConfigInspect("fontSize", { workspaceValue: 14 });
  await updateEditorFontSize(20);
  const writes = getConfigWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, "Workspace");
});

test("编辑器字号：语言专属值（\"[cpp]\"）会盖住通用值，所以先改语言那一层", async () => {
  setup();
  setActiveTextEditor({ document: { languageId: "cpp" } });
  // 通用层（全局）定过 14，且 cpp 有语言专属值
  setConfigInspect("fontSize", { globalValue: 14, languageIds: ["cpp"] });
  setConfigInspect("fontSize@cpp", { globalLanguageValue: 18 });
  await updateEditorFontSize(20);
  const writes = getConfigWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, "Global");
  assert.equal(writes[0].overrideInLanguage, true, "必须写到语言层，否则被通用值盖住");
});

test("编辑器字号：语言专属值定在工作区层就写工作区层", async () => {
  setup();
  setActiveTextEditor({ document: { languageId: "cpp" } });
  setConfigInspect("fontSize", { workspaceValue: 14, languageIds: ["cpp"] });
  setConfigInspect("fontSize@cpp", { workspaceLanguageValue: 18 });
  await updateEditorFontSize(20);
  const writes = getConfigWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, "Workspace");
  assert.equal(writes[0].overrideInLanguage, true);
});

test("编辑器字号：当前文件不是那个语言时，不碰语言层", async () => {
  setup();
  setActiveTextEditor({ document: { languageId: "python" } });
  setConfigInspect("fontSize", { globalValue: 14, languageIds: ["cpp"] });
  await updateEditorFontSize(20);
  const writes = getConfigWrites();
  assert.equal(writes.length, 1);
  assert.notEqual(writes[0].overrideInLanguage, true, "python 文件不该写进 cpp 的语言层");
  assert.equal(writes[0].target, "Global");
});

test("编辑器字号：值先清洗再写", async () => {
  setup();
  await updateEditorFontSize(999);
  assert.equal(getConfigWrites()[0].value, 40, "越界值要夹到上限");
  resetConfigWrites();
  await updateEditorFontSize(Number.NaN);
  assert.equal(getConfigWrites()[0].value, 14, "非法值回落默认档");
});

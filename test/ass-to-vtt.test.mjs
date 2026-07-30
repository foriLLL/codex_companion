import assert from "node:assert/strict";
import test from "node:test";
import { assToWebVtt } from "../src/ass-to-vtt.mjs";

test("ASS 转 WebVTT 保留逗号和换行，并移除样式控制码", () => {
  const result = assToWebVtt(`[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.20,0:00:03.45,Default,,0,0,0,,{\\an8}{\\b1}你好，悟空{\\b0}\\N第二行, 仍有逗号
Dialogue: 0,1:02:03.4,1:02:05.045,Default,,0,0,0,,<危险> & 安全文本
`);

  assert.equal(result, `WEBVTT

00:00:01.200 --> 00:00:03.450
你好，悟空
第二行, 仍有逗号

01:02:03.400 --> 01:02:05.045
&lt;危险&gt; &amp; 安全文本
`);
});

test("ASS 转 WebVTT 跳过绘图和损坏事件", () => {
  const result = assToWebVtt(`[Events]
Format: Start, End, Text
Dialogue: 0:00:00.00,0:00:01.00,{\\p1}m 0 0 l 10 10{\\p0}可见文字
Dialogue: broken,0:00:02.00,忽略
Dialogue: 0:00:03.00,0:00:03.00,忽略
`);
  assert.match(result, /00:00:00\.000 --> 00:00:01\.000\n可见文字/);
  assert.doesNotMatch(result, /m 0 0|忽略/);
});

test("ASS 转 WebVTT 拒绝没有可显示文字的响应", () => {
  assert.throws(
    () => assToWebVtt("[Script Info]\nScriptType: v4.00+"),
    { code: "INVALID_SUBTITLE_RESPONSE" }
  );
});

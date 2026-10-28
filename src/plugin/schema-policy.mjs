import { config } from "zod/v4/core";

// 插件遵守宿主的严格 CSP，不让 SDK 的 schema 校验尝试动态生成代码。
config({ jitless: true });

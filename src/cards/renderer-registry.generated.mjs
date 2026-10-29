// 由 scripts/generate-card-registry.mjs 生成。请勿手改。
// mode: require-entries

import * as renderer0 from "./proxy/renderer.mjs";
import * as renderer1 from "./tasks/renderer.mjs";
import * as renderer2 from "./games/renderer.mjs";
import * as renderer3 from "./hongguo/renderer.mjs";
import * as renderer4 from "./emby/renderer.mjs";

export const RENDERER_REGISTRY = Object.freeze({
  "proxy": renderer0,
  "tasks": renderer1,
  "games": renderer2,
  "hongguo": renderer3,
  "emby": renderer4,
});

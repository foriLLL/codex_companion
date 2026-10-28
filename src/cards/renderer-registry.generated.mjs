// 由 scripts/generate-card-registry.mjs 生成。请勿手改。
// mode: require-entries

import * as renderer0 from "./proxy/renderer.mjs";
import * as renderer1 from "./games/renderer.mjs";
import * as renderer2 from "./hongguo/renderer.mjs";
import * as renderer3 from "./emby/renderer.mjs";

export const RENDERER_REGISTRY = Object.freeze({
  "proxy": renderer0,
  "games": renderer1,
  "hongguo": renderer2,
  "emby": renderer3,
});

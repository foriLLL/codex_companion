// 由 scripts/generate-card-registry.mjs 生成。请勿手改。
// mode: require-entries

import * as renderer0 from "./games/renderer.mjs";
import * as renderer1 from "./hongguo/renderer.mjs";
import * as renderer2 from "./riverclub/renderer.mjs";
import * as renderer3 from "./emby/renderer.mjs";

export const RENDERER_REGISTRY = Object.freeze({
  "games": renderer0,
  "hongguo": renderer1,
  "riverclub": renderer2,
  "emby": renderer3,
});

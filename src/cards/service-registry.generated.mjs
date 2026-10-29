// 由 scripts/generate-card-registry.mjs 生成。请勿手改。
// mode: require-entries
// 无 service.mjs，未注册：games

import * as service0 from "./proxy/service.mjs";
import * as service1 from "./tasks/service.mjs";
import * as service2 from "./hongguo/service.mjs";
import * as service3 from "./emby/service.mjs";

export const SERVICE_REGISTRY = Object.freeze({
  "proxy": service0,
  "tasks": service1,
  "hongguo": service2,
  "emby": service3,
});

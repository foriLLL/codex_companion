// 由 scripts/generate-card-registry.mjs 生成。请勿手改。
// 静态元数据，供 Node 与 bundle 直接 import；运行时不读文件系统。
import { validateCatalog } from "./platform/registry/manifest.mjs";

export const CARD_REGISTRY_HASH = "8e645683a1d39455cb9c0622be1fb70bd388db9d373376b63561c9f05e5bc2b2";

export const CARD_MANIFESTS = validateCatalog([
  {
    "id": "proxy",
    "title": "代理状态",
    "version": 1,
    "defaultEnabled": true,
    "defaultOrder": 0,
    "layout": {
      "height": "content",
      "minHeight": 0,
      "scroll": "outer"
    },
    "lifecycle": {
      "hidden": "suspend",
      "start": "first-visible"
    },
    "state": {
      "scope": "global",
      "version": 1
    },
    "capabilities": [
      "rpc"
    ]
  },
  {
    "id": "games",
    "title": "摸鱼",
    "version": 1,
    "defaultEnabled": true,
    "defaultOrder": 10,
    "layout": {
      "height": "content",
      "minHeight": 440,
      "scroll": "outer"
    },
    "lifecycle": {
      "hidden": "retain",
      "start": "first-visible"
    },
    "state": {
      "scope": "target",
      "version": 1
    },
    "capabilities": [
      "storage"
    ]
  },
  {
    "id": "hongguo",
    "title": "红果短剧",
    "version": 1,
    "defaultEnabled": true,
    "defaultOrder": 20,
    "layout": {
      "height": "viewport",
      "minHeight": 320,
      "scroll": "inner"
    },
    "lifecycle": {
      "hidden": "retain",
      "start": "first-visible"
    },
    "state": {
      "scope": "target",
      "version": 1
    },
    "capabilities": [
      "rpc",
      "storage"
    ]
  },
  {
    "id": "emby",
    "title": "Emby",
    "version": 1,
    "defaultEnabled": true,
    "defaultOrder": 40,
    "layout": {
      "height": "viewport",
      "minHeight": 320,
      "scroll": "inner"
    },
    "lifecycle": {
      "hidden": "retain",
      "start": "first-visible"
    },
    "state": {
      "scope": "target",
      "version": 1
    },
    "capabilities": [
      "rpc",
      "storage"
    ]
  }
]);

const CARD_MANIFESTS_BY_ID = new Map(CARD_MANIFESTS.map((manifest) => [manifest.id, manifest]));

export function getCardManifest(id) {
  return CARD_MANIFESTS_BY_ID.get(id) ?? null;
}

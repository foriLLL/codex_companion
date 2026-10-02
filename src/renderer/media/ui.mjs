export function createMediaUi(scope) {
  const { listen, unlisten, setTimeout, clearTimeout } = scope;
  const makeElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  };

  const toolbarIconPaths = {
    back: ["M11.75 4.75 6.5 10l5.25 5.25", "M7 10h7"],
    search: ["M8.75 13a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5Z", "m12 12 3.5 3.5"],
    servers: ["M4 5.5c0-1 2.69-1.75 6-1.75s6 .75 6 1.75-2.69 1.75-6 1.75S4 6.5 4 5.5Z", "M4 5.5v4c0 1 2.69 1.75 6 1.75s6-.75 6-1.75v-4", "M4 9.5v4c0 1 2.69 1.75 6 1.75s6-.75 6-1.75v-4"],
    logout: ["M8.25 4.5h-2.5A1.75 1.75 0 0 0 4 6.25v7.5c0 .97.78 1.75 1.75 1.75h2.5", "M10.5 6.5 14 10l-3.5 3.5", "M14 10H7.5"],
    subtitles: ["M3.75 5.25h12.5v9.5H3.75z", "M6 10.25h3", "M11 10.25h3", "M6 12.5h2", "M10 12.5h4"],
    folder: ["M4 6.5v7A1.5 1.5 0 0 0 5.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 14.5 7H9.5L8 5H5.5A1.5 1.5 0 0 0 4 6.5Z"],
    film: ["M4 4.75h12v10.5H4z", "M4 8h12", "M4 12h12", "M8 4.75v10.5", "M12 4.75v10.5"],
    fullscreen: ["M8 4.5H5.75A1.25 1.25 0 0 0 4.5 5.75V8", "M12 4.5h2.25c.69 0 1.25.56 1.25 1.25V8", "M8 15.5H5.75A1.25 1.25 0 0 1 4.5 14.25V12", "M12 15.5h2.25c.69 0 1.25-.56 1.25-1.25V12"],
    fullscreenExit: ["M4.5 8h2.25c.69 0 1.25-.56 1.25-1.25V4.5", "M15.5 8h-2.25a1.25 1.25 0 0 1-1.25-1.25V4.5", "M4.5 12h2.25c.69 0 1.25.56 1.25 1.25v2.25", "M15.5 12h-2.25a1.25 1.25 0 0 0-1.25 1.25v2.25"],
    close: ["M5.5 5.5l9 9", "M14.5 5.5l-9 9"]
  };

  const makeToolbarIcon = (name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const pathData of toolbarIconPaths[name] || []) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData);
      svg.append(path);
    }
    return svg;
  };

  // 自定义全屏：对播放容器（而不是 <video> 本身）requestFullscreen，返回键/标题/
  // 字幕菜单/选集导航这些 chrome 是 video 的兄弟节点，原生全屏只会带上 video，
  // 全屏后它们全部消失。原生 controls 的全屏按钮已在 CSS 隐藏，统一走这里。
  const makeFullscreenButton = (view, className) => {
    const button = makeElement("button", className);
    button.type = "button";
    const sync = () => {
      const isFullscreen = view.matches(":fullscreen");
      button.replaceChildren(makeToolbarIcon(isFullscreen ? "fullscreenExit" : "fullscreen"));
      const label = isFullscreen ? "退出全屏" : "全屏";
      button.title = label;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(isFullscreen));
      if (!isFullscreen) delete view.dataset.mouseIdle;
    };
    listen(button, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (view.matches(":fullscreen")) {
        Promise.resolve(document.exitFullscreen()).catch(() => {});
      } else {
        Promise.resolve(view.requestFullscreen()).catch(() => {});
      }
    });
    // 全屏下鼠标静止时隐藏 chrome 与光标（原生 controls 本来就会自动隐藏，
    // 自定义 chrome 不跟着藏的话看电影时顶栏常驻）。mousemove 在非全屏下无视觉影响。
    let idleTimer = null;
    listen(view, "mousemove", () => {
      delete view.dataset.mouseIdle;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { view.dataset.mouseIdle = "true"; }, 2_500);
    });
    // fullscreenchange 以 view 为目标派发，监听器随 view 回收，无需手动清理。
    listen(view, "fullscreenchange", sync);
    sync();
    return button;
  };
  const rpcError = (code, message, retryable = false) => {
    const error = new Error(message || "Emby 请求失败");
    error.code = code || "RPC_ERROR";
    error.retryable = Boolean(retryable);
    return error;
  };

  const toRpcError = (value) => {
    if (value instanceof Error) return value;
    if (value && typeof value === "object") {
      return rpcError(value.code, value.message, value.retryable);
    }
    return rpcError("RPC_ERROR", String(value || "Emby 请求失败"));
  };
  // 优先用原生 Uint8Array.fromBase64（Baseline 2025，新 Chromium 有）：ffmpeg 路径
  // 每批最多 6MB，atob 后逐字符 charCodeAt 在主线程要跑几十万次循环；原生实现
  // 快一个数量级。旧 Renderer 回退到 atob + 逐字符拷贝。
  const decodeBase64 = typeof Uint8Array.fromBase64 === "function"
    ? (data) => Uint8Array.fromBase64(String(data || ""))
    : (data) => {
        const binary = atob(String(data || ""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
      };

  const responseBytes = (result) => {
    if (!result) return new Uint8Array();
    if (result.data instanceof ArrayBuffer) return new Uint8Array(result.data);
    if (ArrayBuffer.isView(result.data)) {
      return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    }
    if (result.encoding === "base64") return decodeBase64(result.data);
    return new TextEncoder().encode(String(result.data ?? ""));
  };

  return { makeElement, makeToolbarIcon, makeFullscreenButton, rpcError, toRpcError, decodeBase64, responseBytes };
}

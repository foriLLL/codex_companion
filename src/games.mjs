// 纯本地小游戏：不联网，状态由卡片持久化，随机数可替换以复现规则测试。
export function createGameEngine(random = Math.random) {
  const shuffle = (items) => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  };
  const spawn = (s) => {
    const empty = s.board.flatMap((v, i) => v ? [] : [i]);
    if (empty.length) s.board[empty[Math.floor(random() * empty.length)]] = random() < .9 ? 2 : 4;
  };
  const slide = (board, direction) => {
    const next = [...board];
    let points = 0;
    for (let line = 0; line < 4; line++) {
      const indices = Array.from({ length: 4 }, (_, i) => direction === "left" ? line * 4 + i : direction === "right" ? line * 4 + 3 - i : direction === "up" ? i * 4 + line : (3 - i) * 4 + line);
      const values = indices.map(i => board[i]).filter(Boolean);
      const out = [];
      for (let i = 0; i < values.length; i++) {
        if (values[i] === values[i + 1]) { out.push(values[i] * 2); points += values[i] * 2; i++; }
        else out.push(values[i]);
      }
      indices.forEach((index, i) => next[index] = out[i] || 0);
    }
    return { board: next, points, changed: next.some((v, i) => v !== board[i]) };
  };
  const neighbors = (i) => Array.from({ length: 81 }, (_, n) => n).filter(n => n !== i && Math.abs(n % 9 - i % 9) <= 1 && Math.abs(Math.floor(n / 9) - Math.floor(i / 9)) <= 1);
  const red = c => c.suit === 1 || c.suit === 2;
  return {
    slide,
    new2048() { const s = { board: Array(16).fill(0), score: 0 }; spawn(s); spawn(s); return s; },
    move2048(s, direction) { const moved = slide(s.board, direction); if (moved.changed) { s.board = moved.board; s.score += moved.points; spawn(s); } return moved.changed; },
    over2048: s => ["left", "right", "up", "down"].every(d => !slide(s.board, d).changed),
    newMines: () => ({ bombs: [], open: [], flags: [], started: false, over: false, won: false }),
    count: (s, i) => neighbors(i).filter(n => s.bombs.includes(n)).length,
    flag(s, i) { if (s.over || s.open.includes(i)) return; s.flags = s.flags.includes(i) ? s.flags.filter(n => n !== i) : s.flags.length < 10 ? [...s.flags, i] : s.flags; },
    reveal(s, i) {
      if (s.over || s.flags.includes(i) || s.open.includes(i)) return;
      if (!s.started) { s.bombs = shuffle(Array.from({ length: 81 }, (_, n) => n).filter(n => n !== i && !neighbors(i).includes(n))).slice(0, 10); s.started = true; }
      if (s.bombs.includes(i)) { s.open.push(i); s.over = true; return; }
      const queue = [i];
      while (queue.length) {
        const n = queue.pop();
        if (s.open.includes(n) || s.flags.includes(n) || s.bombs.includes(n)) continue;
        s.open.push(n);
        if (!neighbors(n).some(x => s.bombs.includes(x))) queue.push(...neighbors(n));
      }
      s.won = s.open.length === 71; s.over = s.won;
    },
    newSolitaire() {
      const deck = shuffle(Array.from({ length: 52 }, (_, id) => ({ id, suit: Math.floor(id / 13), rank: id % 13 + 1, up: false })));
      const columns = Array.from({ length: 7 }, (_, i) => { const pile = deck.splice(0, i + 1); pile.at(-1).up = true; return pile; });
      return { columns, stock: deck, waste: [], foundations: [[], [], [], []] };
    },
    draw(s) { if (s.stock.length) { const c = s.stock.pop(); c.up = true; s.waste.push(c); } else { s.stock = s.waste.reverse(); s.waste = []; s.stock.forEach(c => c.up = false); } },
    transfer(s, from, to) {
      const source = from.kind === "waste" ? s.waste : from.kind === "column" ? s.columns[from.pile] : s.foundations[from.pile];
      if (!source || from.index < 0 || from.index >= source.length) return false;
      const moving = source.slice(from.index), first = moving[0];
      if (!first.up || moving.some((c, i) => i && (!c.up || moving[i - 1].rank !== c.rank + 1 || red(moving[i - 1]) === red(c)))) return false;
      const target = to.kind === "column" ? s.columns[to.pile] : s.foundations[to.pile];
      if (!target || target === source) return false;
      const top = target.at(-1);
      if (to.kind === "foundation") { if (moving.length !== 1 || first.rank !== (top?.rank || 0) + 1 || (top && top.suit !== first.suit)) return false; }
      else if (top ? !top.up || top.rank !== first.rank + 1 || red(top) === red(first) : first.rank !== 13) return false;
      target.push(...source.splice(from.index));
      if (source.length) source.at(-1).up = true;
      return true;
    }
  };
}

// 每个游戏独立校验；一个坏存档不能把其他游戏一起重置。
export function validateGameState(name, value) {
  const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const integer = v => Number.isSafeInteger(v) && v >= 0;
  if (name === "selection") return ["2048", "mines", "solitaire"].includes(value);
  if (!record(value)) return false;
  if (name === "2048") {
    return Array.isArray(value.board) && value.board.length === 16 && integer(value.score)
      && value.board.every(v => integer(v) && (v === 0 || (v >= 2 && Number.isInteger(Math.log2(v)))));
  }
  if (name === "mines") {
    const cells = v => Array.isArray(v) && v.every(n => Number.isInteger(n) && n >= 0 && n < 81)
      && new Set(v).size === v.length;
    if (![value.bombs, value.open, value.flags].every(cells)
      || ["started", "over", "won"].some(key => typeof value[key] !== "boolean")
      || value.flags.length > 10 || value.flags.some(n => value.open.includes(n))) return false;
    if (!value.started) return value.bombs.length === 0 && value.open.length === 0 && !value.over && !value.won;
    if (value.bombs.length !== 10) return false;
    const hit = value.open.some(n => value.bombs.includes(n));
    return value.won ? value.over && !hit && value.open.length === 71
      : value.over ? hit : !hit && value.open.length < 71;
  }
  if (name !== "solitaire" || !Array.isArray(value.columns) || value.columns.length !== 7
    || !Array.isArray(value.foundations) || value.foundations.length !== 4
    || ![...value.columns, ...value.foundations, value.stock, value.waste].every(Array.isArray)) return false;
  const cards = [...value.columns.flat(), ...value.foundations.flat(), ...value.stock, ...value.waste];
  if (cards.length !== 52 || new Set(cards.map(c => c?.id)).size !== 52
    || cards.some(c => !record(c) || !Number.isInteger(c.id) || c.id < 0 || c.id > 51
      || c.suit !== Math.floor(c.id / 13) || c.rank !== c.id % 13 + 1 || typeof c.up !== "boolean")) return false;
  if (value.stock.some(c => c.up) || value.waste.some(c => !c.up)) return false;
  const red = c => c.suit === 1 || c.suit === 2;
  return value.foundations.every(pile => pile.every((c, i) => c.up && c.rank === i + 1 && c.suit === pile[0].suit))
    && value.columns.every(pile => (!pile.length || pile.at(-1).up)
      && pile.every((c, i) => !i || !pile[i - 1].up || (c.up && pile[i - 1].rank === c.rank + 1 && red(pile[i - 1]) !== red(c))));
}

// 仅依赖 Runtime 提供的 storage facade；不访问浏览器全局存储。
export function createGamesPersistence({ storage, engine, signal, reportError } = {}) {
  const names = ["2048", "mines", "solitaire", "selection"];
  const fresh = {
    "2048": () => engine.new2048(), mines: () => engine.newMines(),
    solitaire: () => engine.newSolitaire(), selection: () => "2048"
  };
  const stores = {}, revisions = {}, notices = {};
  const data = { version: 1, selected: "2048", games: {} };
  let disposed = false, legacy = null, legacyNotice = "";
  const active = () => !disposed && !signal?.aborted;
  const report = error => { try { Promise.resolve(reportError?.(error)).catch(() => {}); } catch {} };
  const setValue = (name, value) => { if (name === "selection") data.selected = value; else data.games[name] = value; };
  const getValue = name => name === "selection" ? data.selected : data.games[name];
  const describe = error => error?.code === "STORAGE_QUOTA" ? "存储空间不足，本次进度尚未保存。"
    : "存档无法读取或保存，原数据已保留；当前进度可能无法保留。";
  if (active()) {
    try {
      const raw = storage.readLegacy("codex-companion-games-v1");
      if (raw !== null && raw !== undefined) {
        const candidate = JSON.parse(raw);
        if (!candidate || candidate.version !== 1 || typeof candidate.games !== "object" || !candidate.games) {
          throw Object.assign(new Error("旧游戏存档格式不兼容，已保留源数据"), { code: "STORAGE_INVALID" });
        }
        legacy = candidate;
      }
    } catch (error) { legacyNotice = "旧存档无法读取，源数据已保留。"; report(error); }
  }
  const refresh = name => {
    const result = stores[name].read(fresh[name]());
    revisions[name] = result.revision;
    setValue(name, result.value);
    if (!result.ok) { notices[name] = describe(result.error); report(result.error); }
    return result;
  };
  const save = name => {
    if (!active()) return { ok: false, aborted: true };
    try {
      const result = stores[name].write(getValue(name), { expectedRevision: revisions[name] });
      revisions[name] = result.revision;
      notices[name] = "";
      return result;
    } catch (error) {
      report(error);
      if (!active()) return { ok: false, aborted: true, error };
      if (error.code === "STATE_CONFLICT") {
        const latest = refresh(name);
        notices[name] = latest.ok ? "存档已在其他实例更新，已载入最新进度；刚才的操作未保存。" : describe(latest.error);
        return { ok: false, conflict: true, error };
      }
      notices[name] = describe(error);
      return { ok: false, error };
    }
  };
  for (const name of names) {
    setValue(name, fresh[name]());
    if (!active()) continue;
    stores[name] = storage.namespace(name, { version: 1, validate: value => validateGameState(name, value) });
    const result = refresh(name);
    if (!result.ok || result.revision !== null) continue;
    const old = name === "selection" ? legacy?.selected : legacy?.games?.[name];
    let migrationNotice = "";
    if (old !== undefined) {
      if (validateGameState(name, old)) setValue(name, old);
      else migrationNotice = "这款游戏的旧存档损坏，已重新开始；其他游戏及旧数据均保留。";
    }
    const saved = save(name);
    if (saved.ok && migrationNotice) notices[name] = migrationNotice;
  }
  return {
    data, save,
    getNotice(name) { return [notices[name], name !== "selection" ? notices.selection : "", legacyNotice].filter(Boolean).join(" "); },
    dispose() { disposed = true; },
    diagnostics: () => ({ revisions: { ...revisions }, notices: { ...notices }, disposed })
  };
}

export function mountGames(root, engine, options = {}) {
  const key = "codex-companion-games-v1";
  const document = root.ownerDocument;
  let disposed = false;
  const active = () => !disposed && !options.signal?.aborted;
  const persistence = options.persistence;
  let data = persistence?.data;
  // 仅旧 injection.toString() 兼容入口使用共享 key；新卡总是传入 persistence。
  if (!persistence) {
    try { data = JSON.parse(localStorage.getItem(key)); } catch {}
    const fresh = () => ({ version: 1, selected: "2048", games: { "2048": engine.new2048(), mines: engine.newMines(), solitaire: engine.newSolitaire() } });
    if (!data || data.version !== 1 || !["2048", "mines", "solitaire"].includes(data.selected) || data.games?.["2048"]?.board?.length !== 16 || !Array.isArray(data.games?.mines?.open) || data.games?.solitaire?.columns?.length !== 7) data = fresh();
  }
  let selected = null, flagMode = false, notice = "", storageFailed = false;
  const history = { "2048": [], mines: [], solitaire: [] };
  const save = (name = data.selected) => {
    if (!active()) return;
    if (persistence) {
      const result = persistence.save(name);
      if (result.conflict) {
        if (history[name]) history[name] = [];
        selected = null;
        notice = "";
      }
    } else {
      try { localStorage.setItem(key, JSON.stringify(data)); } catch { storageFailed = true; }
    }
  };
  const remember = () => { const h = history[data.selected]; h.push(JSON.stringify(data.games[data.selected])); if (h.length > 30) h.shift(); };
  root.innerHTML = `<style>
    .games-card{padding:18px;box-sizing:border-box}
    .game-head,.game-tabs,.game-actions{display:flex;gap:6px;align-items:center;justify-content:space-between;margin-bottom:12px}
    .game-head strong{font-size:17px}.game-head span,.game-help{font-size:11px;opacity:.65}
    .games-card button{font:inherit;cursor:pointer;border:0;border-radius:8px;background:rgba(128,128,128,.12);color:inherit;padding:7px}
    .games-card button:focus-visible{outline:2px solid #4a9980;outline-offset:2px}.games-card button[aria-pressed=true]{background:#368568;color:white}
    .game-tabs button{flex:1;font-size:12px}.game-actions{font-size:12px}.game-status{min-height:20px;font-size:12px;margin:10px 0}
    .game-board{outline:none;touch-action:pan-y}.game-grid{display:grid;gap:6px}.grid-2048{grid-template-columns:repeat(4,1fr);background:#a99d8d;padding:7px;border-radius:12px}
    .game-tile{aspect-ratio:1;display:grid;place-items:center;border-radius:7px;font-size:24px;font-weight:700;color:#615344;background:#c7bbad}
    .game-mines{display:grid;grid-template-columns:repeat(9,1fr);gap:3px}.game-mines button{aspect-ratio:1;padding:0;font-size:13px;border-radius:4px;font-weight:600}.game-mines button.open{background:rgba(128,128,128,.04);color:#398677}
    .game-directions{display:flex;gap:6px;justify-content:center;margin-top:12px}.game-directions button{min-width:40px}
    .sol-top{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:14px}.sol-columns{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;min-height:230px}
    .games-card .playing-card{height:57px;width:100%;padding:4px 2px;text-align:left;font-size:12px;border:1px solid #c7c7c7;border-radius:5px;background:#faf8f3;color:#242424;display:block}
    .games-card .playing-card.red{color:#c33f4c}.games-card .playing-card.back{background:repeating-linear-gradient(45deg,#4b796a,#4b796a 3px,#568675 3px,#568675 6px);color:transparent}
    .sol-columns .playing-card{position:relative}.sol-columns .playing-card:not(:last-child){margin-bottom:-32px}.games-card .playing-card.chosen{outline:2px solid #deab39;outline-offset:-2px;background:#fff0be}.games-card .playing-card.empty{background:transparent;border:1px dashed #999;color:#999;text-align:center}
    .game-help{line-height:1.7;margin-top:10px}
  </style><div class="game-head"><strong>摸鱼</strong><span>随时收起 · 接着玩</span></div><div class="game-tabs"></div><div class="game-actions"></div><div class="game-board" tabindex="0" aria-label="小游戏操作区"></div><div class="game-status" role="status"></div><div class="game-help"></div>`;
  const $ = s => root.querySelector(s);
  const button = (label, click, parent, cls = "") => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.className = cls; b.onclick = (...args) => { if (active()) click(...args); }; parent.append(b); return b; };
  const act = fn => { if (!active()) return; remember(); fn(); save(); render(); };
  const move = d => { if (!active()) return; const s = data.games["2048"]; if (!engine.slide(s.board, d).changed) return; act(() => engine.move2048(s, d)); };
  const rank = c => `${["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"][c.rank]}${["♠", "♥", "♦", "♣"][c.suit]}`;
  function render() {
    if (!active()) return;
    const name = data.selected, s = data.games[name], board = $(".game-board");
    const hadFocus = root.contains(root.getRootNode().activeElement);
    $(".game-tabs").replaceChildren();
    for (const [id, label] of [["2048", "2048"], ["mines", "扫雷"], ["solitaire", "接龙"]]) {
      const b = button(label, () => { data.selected = id; selected = null; notice = ""; save("selection"); render(); }, $(".game-tabs")); b.setAttribute("aria-pressed", String(name === id));
    }
    $(".game-actions").replaceChildren();
    button("新一局", async () => {
      const confirmed = options.confirmReset ? await options.confirmReset() : document.defaultView.confirm("重新开始这款游戏？当前进度将被替换。");
      if (!confirmed || !active() || data.selected !== name) return;
      act(() => { data.games[name] = name === "2048" ? engine.new2048() : name === "mines" ? engine.newMines() : engine.newSolitaire(); selected = null; notice = ""; });
    }, $(".game-actions"));
    const undo = button("撤销", () => { data.games[name] = JSON.parse(history[name].pop()); selected = null; notice = ""; save(); render(); }, $(".game-actions")); undo.disabled = !history[name].length;
    board.replaceChildren();
    let status = "", help = "";
    if (name === "2048") {
      const grid = document.createElement("div"); grid.className = "game-grid grid-2048"; board.append(grid);
      s.board.forEach(v => { const el = document.createElement("div"); el.className = "game-tile"; el.textContent = v || ""; if (v) { el.style.background = `hsl(${Math.max(24, 44 - Math.log2(v) * 2)} 70% ${Math.max(42, 96 - Math.log2(v) * 5)}%)`; if (v >= 16) el.style.color = "white"; } grid.append(el); });
      const controls = document.createElement("div"); controls.className = "game-directions"; board.append(controls);
      for (const [d, label] of [["left", "←"], ["up", "↑"], ["down", "↓"], ["right", "→"]]) button(label, () => move(d), controls).setAttribute("aria-label", `向${{ left: "左", right: "右", up: "上", down: "下" }[d]}移动`);
      status = `得分 ${s.score}${engine.over2048(s) ? " · 没有可移动的位置了" : s.board.some(v => v >= 2048) ? " · 达成 2048！可以继续" : ""}`;
      help = "点击棋盘后用方向键移动，也可以点箭头。相同数字合并。";
    } else if (name === "mines") {
      const flag = button(flagMode ? "插旗模式 ✓" : "插旗模式", () => { flagMode = !flagMode; render(); }, $(".game-actions")); flag.setAttribute("aria-pressed", String(flagMode));
      const grid = document.createElement("div"); grid.className = "game-mines"; board.append(grid);
      for (let i = 0; i < 81; i++) {
        const open = s.open.includes(i), bomb = s.over && s.bombs.includes(i), count = engine.count(s, i);
        const b = button(bomb ? "✹" : s.flags.includes(i) ? "⚑" : open ? count || "" : "", () => act(() => flagMode ? engine.flag(s, i) : engine.reveal(s, i)), grid, open ? "open" : "");
        b.setAttribute("aria-label", `${Math.floor(i / 9) + 1}行${i % 9 + 1}列${open ? `，已打开，${count}颗邻雷` : "，未打开"}`);
        b.oncontextmenu = e => { if (!active()) return; e.preventDefault(); act(() => engine.flag(s, i)); };
      }
      status = s.won ? "全部排除，赢了！" : s.over ? "踩到雷了，可以撤销再试" : `9 × 9 · 10 颗雷 · 已标记 ${s.flags.length}`;
      help = "首次点击周围无雷。右键插旗，或切换插旗模式后点击。";
    } else {
      const top = document.createElement("div"); top.className = "sol-top"; board.append(top);
      button(s.stock.length ? `牌堆 ${s.stock.length}` : "翻回", () => act(() => { engine.draw(s); selected = null; notice = ""; }), top, "playing-card back").style.color = "white";
      const choose = (from, to) => {
        if (selected && to) {
          const before = JSON.stringify(s);
          if (engine.transfer(s, selected, to)) { history.solitaire.push(before); if (history.solitaire.length > 30) history.solitaire.shift(); selected = null; notice = ""; save(); render(); return; }
          notice = "这里放不下：列内红黑交替递减，收牌区同花色从 A 递增。";
        }
        selected = from; render();
      };
      const card = (c, parent, from, to) => {
        const picked = selected && from && selected.kind === from.kind && selected.pile === from.pile && from.index >= selected.index;
        const b = button(c ? c.up ? rank(c) : "背面" : to?.kind === "foundation" ? "A" : "K", () => choose(c?.up ? from : null, to), parent, `playing-card ${!c ? "empty" : !c.up ? "back" : c.suit === 1 || c.suit === 2 ? "red" : ""} ${picked ? "chosen" : ""}`);
        b.setAttribute("aria-label", c ? c.up ? rank(c) : "未翻开的牌" : to?.kind === "foundation" ? "空收牌区" : "空列");
      };
      card(s.waste.at(-1), top, { kind: "waste", index: s.waste.length - 1 }); top.append(document.createElement("span"));
      s.foundations.forEach((p, pile) => card(p.at(-1), top, { kind: "foundation", pile, index: p.length - 1 }, { kind: "foundation", pile }));
      const cols = document.createElement("div"); cols.className = "sol-columns"; board.append(cols);
      s.columns.forEach((p, pile) => { const col = document.createElement("div"); cols.append(col); if (!p.length) card(null, col, null, { kind: "column", pile }); p.forEach((c, index) => card(c, col, { kind: "column", pile, index }, { kind: "column", pile })); });
      const done = s.foundations.reduce((n, p) => n + p.length, 0);
      status = done === 52 ? "52 张全部归位，赢了！" : notice || `已归位 ${done} / 52${selected ? " · 已选中，点击目标位置" : ""}`;
      help = "经典接龙 · 每次翻一张。先点牌，再点目标列或收牌区；列内红黑交替递减，空列放 K，收牌区从 A 到 K。";
    }
    if (hadFocus) board.focus({ preventScroll: true });
    $(".game-status").textContent = status;
    const storageNotice = persistence?.getNotice(name) || (storageFailed ? "当前环境无法保存，退出页面后进度会丢失。" : "");
    $(".game-help").textContent = help + (storageNotice ? ` ${storageNotice}` : " 进度自动保存在本机。");
    if (storageNotice) $(".game-status").textContent = `${status} · ${storageNotice}`;
  }
  const onKey = e => {
    if (!active()) return;
    const directions = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    if (data.selected !== "2048" || !directions[e.key]) return;
    e.preventDefault(); e.stopPropagation(); move(directions[e.key]);
  };
  const onPointer = e => {
    if (active() && !e.target.closest("button")) $(".game-board").focus({ preventScroll: true });
  };
  const cleanups = [];
  const listen = (type, callback) => {
    if (options.effects) cleanups.push(options.effects.listen(root, type, callback));
    else {
      root.addEventListener(type, callback);
      cleanups.push(() => root.removeEventListener(type, callback));
    }
  };
  listen("keydown", onKey);
  listen("pointerdown", onPointer);
  // 旧入口初始化兼容原存档；新入口已经逐 namespace 读取/迁移，不再整包保存。
  if (!persistence) save();
  render();
  return () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    persistence?.dispose();
    // DOM 属性回调也解除；即使外部保留旧 button，active guard 仍阻止迟到写入。
    for (const element of root.querySelectorAll("button")) { element.onclick = null; element.oncontextmenu = null; }
  };
}

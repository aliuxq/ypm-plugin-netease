// 网易云音乐 for YesPlayMusic 3.x
//
// 本插件是社区维护的第三方音乐源插件，与网易公司、YesPlayMusic 官方均无关联。
//
// 所有请求走网易云 PC 客户端使用的 eapi 接口（见 client.js）。插件导出的函数名就是
// 宿主调用的操作名：不导出的功能界面上不会出现。每个函数收到一个参数对象，可以 async，
// 返回值需能 JSON 序列化。
//
// 登录：扫码（host.signInPrompt 显示二维码），或者在插件设置里粘贴 Cookie（MUSIC_U）。

import { api, fail, hasSession, resetSession, verify, currentAccount } from "./client.js";
import * as model from "./models.js";
import { t } from "./i18n.js";

const PAGE = 50;
const LIKED_PAGE = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const offsetOf = (value) => Math.max(0, Math.floor(Number(value) || 0));

const needSignIn = () => fail("signIn", "请先登录网易云音乐");

// 只读接口偶尔超时（网易云返回 -601），再试一次。
const twice = (fn) => fn().catch(() => fn());

// ── 账号状态（内存缓存） ──

let me = null; // { id, name, imageUrl }
let meToken = ""; // me 属于哪份登录状态（MUSIC_U）
let likedIds = null; // { uid, at, ids: string[] }
let savedAlbumIds = null; // { uid, ids: Set, complete: boolean }

function resetAccountState() {
  likedIds = null;
  savedAlbumIds = null;
}

// ── 手动 Cookie（设置里粘贴的 MUSIC_U） ──

function parseCookie(str) {
  const out = {};
  for (const part of String(str || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function manualCookie() {
  const manual = String(host.setting("cookie") || "").trim();
  if (!manual) return null;
  const c = manual.includes("=") ? parseCookie(manual) : { MUSIC_U: manual };
  return c.MUSIC_U ? c : null;
}

function manualIgnored(c) {
  return host.storage.get("ignoreCookie") === host.crypto.md5(c.MUSIC_U);
}

// 当前用哪份登录态：设置里手填的优先。
function userCookie() {
  const c = manualCookie();
  if (c && !manualIgnored(c)) return c;
  return host.storage.get("cookies") || {};
}

const loggedIn = () => Boolean(userCookie().MUSIC_U);

// ── 数据转换（在 model 基础上补充时长缓存，供上报听歌记录用） ──

const durations = new Map(); // 歌曲 id → 时长（秒）

function trackOf(s, privilege) {
  const tr = model.track(s, privilege);
  if (tr && tr.duration > 0) {
    if (durations.size > 50000) durations.clear();
    durations.set(tr.id, Math.round(tr.duration / 1000));
  }
  return tr;
}

function tracksOf(songs, privileges) {
  const pm = new Map((privileges || []).map((p) => [String(p.id), p]));
  return (songs || []).map((s) => trackOf(s, pm.get(String(s.id)))).filter(Boolean);
}

// 按 id 批量取歌曲详情，返回顺序与 ids 一致；查不到的（已删除）不在结果里。
async function songDetails(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
  const byId = new Map();
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      // 9 秒 + 一次重试 = 最坏 18 秒。默认的 20 秒 × 2 次会超过宿主 30 秒的调用上限，
      // 弱网下表现为「点了没反应，过很久才报错」。宁可早点失败让用户重试。
      const r = await twice(() =>
        api("/api/v3/song/detail", { c: JSON.stringify(chunk.map((id) => ({ id: Number(id) }))) }, { timeout: 9000 })
      );
      for (const tr of tracksOf(r.songs, r.privileges)) byId.set(tr.id, tr);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

// ── 账号 ──

export async function account() {
  // 设置里的 Cookie 被清空后，之前记下的「这一份不用了」也作废。
  if (!manualCookie() && host.storage.get("ignoreCookie")) host.storage.remove("ignoreCookie");
  const token = userCookie().MUSIC_U || "";
  if (!token) {
    me = null;
    meToken = "";
    return null;
  }
  const r = await api("/api/nuser/account/get");
  if (!r.profile) {
    me = null;
    meToken = "";
    return null;
  }
  const next = { id: String(r.profile.userId), name: r.profile.nickname || "", imageUrl: r.profile.avatarUrl || "" };
  if (!me || me.id !== next.id) resetAccountState();
  me = next;
  meToken = token;
  return me;
}

async function myId() {
  const token = userCookie().MUSIC_U || "";
  if (!token) throw needSignIn();
  if (!me || meToken !== token) await account();
  if (!me) throw needSignIn();
  return me.id;
}

// 每次登录一个编号。用户关掉登录窗口时宿主不会通知插件，上一次的轮询还在跑；
// 再点登录时让它停下，避免两边轮流改二维码。
let signInRun = 0;

export async function signIn() {
  const run = ++signInRun;

  // 设置里粘贴了 Cookie：先试它，能用就不用扫码。
  const manual = manualCookie();
  if (manual) {
    host.storage.remove("ignoreCookie");
    try {
      const a = await account();
      if (a) return a;
    } catch (e) {
      if (e.code !== "signIn") throw e;
    }
    host.storage.set("ignoreCookie", host.crypto.md5(manual.MUSIC_U)); // 这份失效了，改用扫码
  }

  const deadline = Date.now() + 9.5 * 60 * 1000; // 宿主最多等 10 分钟
  while (Date.now() < deadline) {
    const k = await api("/api/login/qrcode/unikey", { type: 3 });
    if (run !== signInRun) throw new Error(t("登录已取消"));
    const qr = `https://music.163.com/login?codekey=${k.unikey}`;
    host.signInPrompt({ qr, text: t("打开网易云音乐 App 扫码登录") });
    while (Date.now() < deadline) {
      await sleep(2000);
      if (run !== signInRun) throw new Error(t("登录已取消"));
      const { result, cookies } = await api(
        "/api/login/qrcode/client/login",
        { key: k.unikey, type: 3 },
        { raw: true, cookies: {}, persist: false, withCookies: true }
      );
      if (result.code === 800) break; // 二维码过期，换一个
      if (result.code === 802) host.signInPrompt({ qr, text: t("已扫码，请在手机上确认") });
      if (result.code === 803) {
        if (!cookies.MUSIC_U) throw new Error(t("登录成功但没拿到 Cookie，请在插件设置里手动粘贴"));
        host.storage.set("cookies", cookies);
        const a = await verify();
        if (!a) throw new Error(t("登录成功但没拿到 Cookie，请在插件设置里手动粘贴"));
        return a;
      }
      if (result.code === 8821) throw new Error(t("扫码登录被网易云风控拦截了，请在插件设置里粘贴 MUSIC_U Cookie"));
      if (result.code !== 801 && result.code !== 802) throw new Error(result.message || `QR: ${result.code}`);
    }
  }
  throw new Error(t("登录超时了，请再试一次"));
}

export async function signOut() {
  signInRun++;
  resetSession();
  me = null;
  meToken = "";
  resetAccountState();
  dropListsCache();
  dropLikedPages();
}

export async function profile() {
  const uid = await myId();
  const [r, lists, week, albums] = await Promise.all([
    api(`/api/v1/user/detail/${uid}`),
    rawPlaylists(uid),
    api("/api/v1/play/record", { uid, type: 1 }).catch(() => null), // 最近一周听得最多
    api("/api/album/sublist", { limit: 1, offset: 0, total: true }).catch(() => null), // 只要数量
  ]);
  const p = r.profile || {};
  const mine = (lists || []).map((x) => model.playlist(x, uid)).filter((x) => x.mine);
  const weekData = week?.weekData || [];
  const top = weekData
    .slice(0, 20)
    .map((x) => {
      const tr = trackOf(x.song);
      return tr ? { ...tr, plays: x.playCount || 0 } : null;
    })
    .filter(Boolean);

  // 本周最常听的歌手：把一周榜单里每首歌的播放次数按歌手汇总。
  const byArtist = new Map();
  for (const x of weekData) {
    const plays = Number(x.playCount) || 0;
    for (const a of x.song?.ar || []) {
      if (!a?.name) continue;
      const key = String(a.id || a.name);
      const cur = byArtist.get(key) || { artist: model.artist(a), plays: 0 };
      cur.plays += plays;
      byArtist.set(key, cur);
    }
  }
  const topArtists = [...byArtist.values()].sort((a, b) => b.plays - a.plays).slice(0, 5);

  const badges = [];
  if (r.level) badges.push(`Lv.${r.level}`);
  if (Number(p.vipType) > 0) badges.push(t("黑胶 VIP"));

  const facts = [
    { label: t("关注"), value: String(p.follows ?? 0) },
    { label: t("粉丝"), value: String(p.followeds ?? 0) },
  ];
  if (p.createTime) facts.push({ label: t("加入"), value: `${new Date(p.createTime).getFullYear()} 年` });

  return {
    name: p.nickname || me.name,
    imageUrl: p.avatarUrl ? String(p.avatarUrl).replace(/^http:/, "https:") : undefined,
    signature: p.signature || undefined,
    badges,
    facts,
    // 宿主最多画三张统计卡，点进去分别跳到音乐库对应的标签。
    stats: [
      { label: t("累计听歌"), value: r.listenSongs ?? 0, unit: t("首"), link: "songs" },
      { label: t("收藏专辑"), value: albums?.count ?? 0, link: "albums" },
      { label: t("我的歌单"), value: mine.length, link: "playlists" },
    ],
    topArtists: topArtists.length ? topArtists : undefined,
    topTracks: top.length ? { title: t("本周最常听"), tracks: top } : undefined,
    playlists: mine,
  };
}

// ── 发现 ──

// 榜单条目带上前三首歌：宿主的「榜单卡片」会把这几首直接列在卡片里。
// /api/toplist 只返回歌单本身（tracks 是 null），歌要另外取一次。
async function chartOf(x) {
  const r = await api("/api/v6/playlist/detail", { id: x.id, n: 3, s: 8 }, { timeout: 8000 }).catch(() => null);
  return { ...model.playlist(x, me?.id || ""), tracks: tracksOf(r?.playlist?.tracks).slice(0, 3) };
}

// 首页顺序：模式大卡 → 榜单卡 → 推荐歌单 → 新碟墙 → 新歌网格。
// 宿主能画的排布只有 modes / shelf / songs / charts / grid 五种，这里按视觉重量排。
export async function home() {
  const signed = loggedIn();
  const quiet = (p, label) =>
    p.catch((e) => {
      console.warn(label, e.message || e);
      return null;
    });
  const [daily, rec, fresh, discs, charts] = await Promise.all([
    signed ? quiet(dailyInfo(), "daily") : null,
    quiet(
      signed ? api("/api/v1/discovery/recommend/resource") : api("/api/personalized/playlist", { limit: 30, total: true, n: 1000 }),
      "recommend"
    ),
    quiet(api("/api/personalized/newsong", { type: "recommend", limit: 12, areaId: 0 }), "newsong"),
    quiet(api("/api/album/new", { area: "ALL", limit: 20, offset: 0, total: true }), "newalbum"),
    quiet(api("/api/toplist"), "toplist"),
  ]);
  if (!rec && !fresh && !discs && !charts) throw new Error(t("连不上网易云音乐"));

  const sections = [];
  const modes = [];
  if (signed) {
    if (daily?.tracks?.length) {
      modes.push({
        title: t("每日推荐"),
        subtitle: t("每天 6:00 更新"),
        imageUrl: daily.cover || undefined,
        tracks: daily.tracks,
      });
    }
    modes.push({ title: t("私人 FM"), subtitle: t("根据你的口味一直放下去"), station: "fm" });
  }
  if (modes.length) sections.push({ style: "modes", modes });

  const top = (
    await Promise.all((charts?.list || []).filter((x) => x && x.id).slice(0, 4).map(chartOf))
  ).filter((x) => x.tracks.length);
  if (top.length) sections.push({ title: t("排行榜"), style: "charts", playlists: top });

  const lists = (rec?.recommend || rec?.result || []).map((x) => model.playlist(x, me?.id || ""));
  if (lists.length) sections.push({ title: t("推荐歌单"), style: "shelf", playlists: lists });

  const albums = (discs?.albums || []).map(model.album);
  if (albums.length) sections.push({ title: t("新碟上架"), style: "grid", albums });

  const tracks = (fresh?.result || []).map((x) => trackOf(x.song)).filter(Boolean);
  if (tracks.length) sections.push({ title: t("新歌速递"), style: "songs", tracks });

  return { title: t("网易云音乐"), sections };
}

// ── 发现页 ──
//
// 宿主 3.0.0 的侧边栏是固定的四个按钮，plugin.json 里的 navigation 不会出现在侧边栏；
// Browse 的 title / description / imageUrl 和 Section 的 links / morePage 也不会被画出来。
// 所以所有二级页面都必须挂在这一页的 tabs（组卡）和 filters（分类标签）上。

// 分类面板：和网易云的「更多分类」一致，先用 API 真实存在的分类名。
const GROUPS = [
  ["语种", ["华语", "欧美", "日语", "韩语", "粤语"]],
  ["风格", ["流行", "摇滚", "民谣", "电子", "说唱", "爵士", "古典", "轻音乐", "古风", "ACG", "民族"]],
  ["场景", ["清晨", "夜晚", "学习", "工作", "运动", "通勤", "旅行"]],
  ["情感", ["怀旧", "清新", "浪漫", "伤感", "治愈", "放松", "孤独"]],
  ["主题", ["影视原声", "游戏", "动漫", "校园", "雨天"]],
];

const QUICK = ["华语", "欧美", "日语", "流行", "摇滚", "民谣", "电子"];
const PL_ALL = "pl:全部";
const LISTENS = "listens";
const CLOUD_PAGE = 200;

const catOf = (page) => (!page || page === PL_ALL ? "全部" : page.slice(3));

// ── 发现页顶部栏目（可以在插件设置里改顺序、改名、增减） ──
//
// 宿主的栏目栏不接受用户拖动，插件也不能往界面加控件；但栏目本身是插件给的
// tabs，所以把「显示哪几个、什么顺序、叫什么」做成设置项是可行的。
const TAB_DEFS = {
  pl: { title: () => t("歌单广场"), page: () => PL_ALL, needsSignIn: false },
  listens: { title: () => t("听歌记录"), page: () => LISTENS, needsSignIn: true },
  charts: { title: () => t("排行榜"), page: () => "charts", needsSignIn: false },
  new: { title: () => t("新碟上架"), page: () => "new", needsSignIn: false },
  cloud: { title: () => t("我的云盘"), page: () => "cloud", needsSignIn: true },
};

const TAB_PRESETS = {
  "": ["pl", "listens", "charts", "new", "cloud"],
  compact: ["pl", "charts"],
  mine: ["pl", "listens", "cloud"],
};

// 把设置读成 [{ key, name }]；不认识的名字直接跳过，写错不会让发现页变空。
function tabSpec() {
  const preset = String(host.setting("tabs") || "");
  if (preset !== "custom") {
    return (TAB_PRESETS[preset] || TAB_PRESETS[""]).map((key) => ({ key, name: "" }));
  }
  const raw = String(host.setting("tabOrder") || "").trim();
  if (!raw) return TAB_PRESETS[""].map((key) => ({ key, name: "" }));
  return raw
    .split(/[,，;；\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf("=");
      return i > 0 ? { key: x.slice(0, i).trim().toLowerCase(), name: x.slice(i + 1).trim() } : { key: x.toLowerCase(), name: "" };
    });
}

// 顶部导航必须每一页都带上：宿主的 tab 栏是用「当前这一页」的返回值画的，
// 少了它翻到二级页就只剩内容、没有回去了。
function bars(page, count = 0) {
  const signed = loggedIn();
  const onPl = !page || page.startsWith("pl:");
  const onListens = String(page).startsWith(LISTENS);

  const on = (key, pageOf) => {
    if (key === "pl") return onPl;
    if (key === "listens") return onListens;
    if (key === "cloud") return String(page).startsWith("cloud");
    return String(page) === pageOf;
  };

  const tabs = [];
  for (const spec of tabSpec()) {
    const def = TAB_DEFS[spec.key];
    if (!def) continue;
    if (def.needsSignIn && !signed) continue;
    const target = def.page();
    tabs.push({ title: spec.name || def.title(), page: target, selected: on(spec.key, target) });
  }
  // 一个都没剩（比如全写错了）：至少把默认页的入口给回去。
  if (!tabs.length) tabs.push({ title: t("歌单广场"), page: PL_ALL, selected: onPl });

  // 听歌记录：网易云只回最近 300 次播放，翻不了更早，所以只有「按天」和「本周最常听」两个视图。
  if (onListens) {
    const week = String(page) === `${LISTENS}:week`;
    return {
      tabs,
      filters: [
        [
          { title: t("按天"), page: LISTENS, selected: !week },
          { title: t("本周最常听"), page: `${LISTENS}:week`, selected: week },
        ],
      ],
    };
  }

  if (onPl) {
    const cat = catOf(page);
    // 从分类面板里选的小众分类（比如「古风」）不在快捷行里，补一个进去，否则那一排没有选中态。
    const quick = cat !== "全部" && !QUICK.includes(cat) ? [cat, ...QUICK] : QUICK;
    const filters = [
      [
        { title: t("全部"), page: PL_ALL, selected: cat === "全部" },
        ...quick.map((c) => ({ title: t(c), page: `pl:${c}`, selected: c === cat })),
      ],
      [
        {
          title: t("更多分类"),
          groups: GROUPS.map(([name, opts]) => ({
            title: t(name),
            options: opts.map((o) => ({ title: t(o), page: `pl:${o}`, selected: o === cat })),
          })),
        },
      ],
    ];
    return { tabs, filters };
  }
  if (String(page).startsWith("cloud") && count > CLOUD_PAGE) {
    const pages = Math.ceil(count / CLOUD_PAGE);
    const cur = Math.max(0, Number(String(page).split(":")[1]) || 0);
    return {
      tabs,
      filters: [
        Array.from({ length: Math.min(pages, 30) }, (_, i) => ({
          title: String(i + 1),
          page: i === 0 ? "cloud" : `cloud:${i * CLOUD_PAGE}`,
          selected: i === Math.floor(cur / CLOUD_PAGE),
        })),
      ],
    };
  }
  return { tabs };
}

// 听歌记录的时间戳是 UTC 毫秒，按北京时间分天。
const TZ = 8 * 3600 * 1000;

function dayOf(ms) {
  const d = new Date(ms + TZ);
  return { key: d.toISOString().slice(0, 10), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function dayLabel(g) {
  const today = dayOf(Date.now());
  const yesterday = dayOf(Date.now() - 86400000);
  const tail = g.key === today.key ? ` · ${t("今天")}` : g.key === yesterday.key ? ` · ${t("昨天")}` : "";
  const zh = String(host.language() || "zh").toLowerCase().startsWith("zh");
  return `${zh ? `${g.m}月${g.d}日` : g.key}${tail}`;
}

export async function browse({ page } = {}) {
  const p = String(page || "");

  // 听歌记录：按天分组的播放历史；另一个视图是本周播放次数排行。
  if (p === LISTENS || p === `${LISTENS}:week`) {
    if (p === `${LISTENS}:week`) {
      const uid = await myId();
      const r = await api("/api/v1/play/record", { uid, type: 1 });
      const tracks = (r.weekData || []).map((x) => trackOf(x.song)).filter(Boolean);
      if (!tracks.length) throw new Error(t("这里还没有内容"));
      return { ...bars(p), sections: [{ title: `${t("本周最常听")} · ${tracks.length}`, tracks }] };
    }
    const info = await recentInfo(true);
    const byDay = new Map();
    for (const it of info.items) {
      const g = dayOf(it.at);
      if (!byDay.has(g.key)) byDay.set(g.key, { ...g, tracks: [] });
      byDay.get(g.key).tracks.push(it.track);
    }
    const days = [...byDay.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
    if (!days.length) throw new Error(t("这里还没有内容"));
    return {
      ...bars(p),
      sections: days.map((g) => ({ title: `${dayLabel(g)} · ${g.tracks.length}`, tracks: g.tracks })),
    };
  }

  if (p === "charts") {
    const r = await api("/api/toplist");
    const all = (r.list || []).filter((x) => x && x.id);
    // 只有前四张卡需要列歌，其余按普通卡片铺开，不多打四个请求。
    const feats = all.slice(0, 4);
    const head = (await Promise.all(feats.map(chartOf))).filter((x) => x.tracks.length);
    // 前四张卡列歌，其余按普通卡片铺开；总数收在 28 张以内，避免一页太多封面拖慢滚动。
    const rest = all.slice(feats.length, 28).map((x) => model.playlist(x, me?.id || ""));
    const sections = [{ title: t("排行榜"), style: "charts", playlists: head }];
    if (rest.length) sections.push({ title: t("更多榜单"), style: "grid", playlists: rest });
    return { ...bars(p), sections };
  }

  if (p === "new") {
    const r = await api("/api/album/new", { area: "ALL", limit: 50, offset: 0, total: true });
    const albums = (r.albums || []).map(model.album);
    return { ...bars(p), sections: [{ title: t("新碟上架"), style: "grid", albums }] };
  }

  if (p.startsWith("cloud")) {
    const uid = await myId();
    const offset = Math.max(0, Number(p.split(":")[1]) || 0);
    const j = await api("/api/v1/cloud/get", { limit: CLOUD_PAGE, offset });
    const data = Array.isArray(j.data) ? j.data : [];
    const count = Number(j.count) || 0;
    return { ...bars(p, count), sections: [{ title: t("我的云盘"), tracks: data.map(model.cloudTrack) }] };
  }

  // 歌单广场（默认页也是它）
  const cat = catOf(p);
  const r = await api("/api/playlist/list", { cat, order: "hot", limit: 60, offset: 0, total: true });
  return {
    ...bars(p || PL_ALL),
    sections: [{ style: "grid", playlists: (r.playlists || []).map((x) => model.playlist(x, me?.id || "")) }],
  };
}

const KINDS = { tracks: 1, albums: 10, artists: 100, playlists: 1000 };

export async function search({ query, kind = "tracks", offset = 0 }) {
  if (!query || !KINDS[kind]) return {};
  const r = await api("/api/cloudsearch/pc", { s: query, type: KINDS[kind], limit: PAGE, offset, total: true });
  const res = r.result || {};
  let out;
  if (kind === "tracks") out = { tracks: tracksOf(res.songs), total: res.songCount };
  if (kind === "albums") out = { albums: (res.albums || []).map(model.album), total: res.albumCount };
  if (kind === "artists") out = { artists: (res.artists || []).map(model.artist), total: res.artistCount };
  if (kind === "playlists") out = { playlists: (res.playlists || []).map((x) => model.playlist(x, me?.id || "")), total: res.playlistCount };
  const got = (out.tracks || out.albums || out.artists || out.playlists).length;
  out.total = out.total || 0;
  out.more = got > 0 && offset + got < out.total;
  return out;
}

export async function suggest({ query }) {
  if (!query) return [];
  const r = await api("/api/search/suggest/keyword", { s: query });
  return (r.result?.allMatch || []).map((x) => x.keyword).filter(Boolean);
}

export async function hotSearches() {
  const r = await api("/api/hotsearchlist/get");
  return (r.data || []).filter((x) => x.searchWord).map((x) => (x.content ? { word: x.searchWord, hint: x.content } : x.searchWord));
}

// ── 音乐库 ──

async function likedList(force = false) {
  const uid = await myId();
  if (!force && likedIds && likedIds.uid === uid && Date.now() - likedIds.at < 60_000) return likedIds.ids;
  const r = await api("/api/song/like/get", { uid });
  likedIds = { uid, at: Date.now(), ids: (r.ids || []).map(String) };
  return likedIds.ids;
}

// 已经取过的红心歌页：宿主切标签会重取，45 秒内直接给上次的结果，
// 免得每次切页都重新拉 531 首歌的详情。喜欢/取消喜欢时作废。
const likedPages = new Map(); // key = uid:offset

const dropLikedPages = () => likedPages.clear();

export async function liked({ offset = 0 } = {}) {
  const start = offsetOf(offset);
  const uid = await myId();
  const key = `${uid}:${start}`;
  const hit = likedPages.get(key);
  if (hit && Date.now() - hit.at < 45_000) return { tracks: hit.tracks, more: hit.more };

  const entries = await likedEntries();
  const page = entries.slice(start, start + LIKED_PAGE);
  const tracks = await songDetails(page.map((e) => e.id));
  const at = new Map(page.map((e) => [e.id, e.at]));
  const out = {
    tracks: tracks.map((tr) => ({ ...tr, added: at.get(tr.id) || tr.added })),
    more: start + page.length < entries.length,
  };
  if (likedPages.size > 8) likedPages.clear();
  likedPages.set(key, { at: Date.now(), ...out });
  return out;
}

// 「我喜欢」的真实顺序和加入时间。
//
// 宿主的音乐库「歌曲」栏会按 added 倒序排、再按月分组（月份标题 + 当月曲数 +
// 「今天 / 3 天前 / 11月3日」）。只给歌曲 id 的话这些全落进「更早」一组、
// 日期列空白，整页看着就像没设计。所以顺序和 added 都从「我喜欢的音乐」这个
// 歌单本身取：/api/song/like/get 只返回一堆 id，没有时间也没有顺序。
let favCache = null; // { uid, at, entries: [{ id, at: ISO }] }

async function likedEntries(force = false) {
  const uid = await myId();
  if (!force && favCache && favCache.uid === uid && Date.now() - favCache.at < 60_000) return favCache.entries;
  const lists = await rawPlaylists(uid);
  const fav = (lists || []).find((x) => x && x.specialType === 5 && x.id);
  if (fav) {
    // n=0：只要 trackIds（顺序 + 加入时间），不要歌单里那几百首完整歌曲对象，
    // 响应从 1.2 MB / 600 ms 降到 85 KB / 80 ms。
    const r = await api("/api/v6/playlist/detail", { id: fav.id, n: 0, s: 8 });
    const ids = r.playlist?.trackIds || [];
    if (ids.length) {
      const entries = ids.map((e) => ({
        id: String(e.id),
        at: typeof e.at === "number" && e.at > 0 ? new Date(e.at).toISOString() : undefined,
      }));
      favCache = { uid, at: Date.now(), entries };
      return entries;
    }
  }
  // 拿不到歌单（接口变动 / 只是普通红心）时退回旧的 id 列表，至少歌是全的。
  const ids = await likedList(force);
  const entries = ids.map((id) => ({ id, at: undefined }));
  favCache = { uid, at: Date.now(), entries };
  return entries;
}

export async function isLiked({ ids }) {
  if (!loggedIn()) return {};
  const set = new Set(await likedList());
  return Object.fromEntries((ids || []).map((id) => [id, set.has(String(id))]));
}

export async function like({ id, on }) {
  const uid = await myId();
  await api("/api/radio/like", { alg: "itembased", trackId: Number(id), like: !!on, time: "3" });
  dropLikedPages(); // 红心歌的页缓存跟着作废，下次打开就是最新顺序
  if (likedIds && likedIds.uid === uid) {
    const s = new Set(likedIds.ids);
    on ? s.add(String(id)) : s.delete(String(id));
    likedIds.ids = [...s];
  }
}

// 必须返回纯数组：宿主 3.0.0 的音乐库页把返回值直接当数组用，返回 { albums, more } 会报类型错误。
export async function savedAlbums({ offset = 0 } = {}) {
  const uid = await myId();
  const r = await api("/api/album/sublist", { limit: PAGE, offset, total: true });
  const list = (r.data || []).filter((a) => a && a.id);
  if (offset === 0 || !savedAlbumIds || savedAlbumIds.uid !== uid) savedAlbumIds = { uid, ids: new Set(), complete: false };
  for (const a of list) savedAlbumIds.ids.add(String(a.id));
  if (!list.length || r.hasMore === false) savedAlbumIds.complete = true;
  return list.map((a) => ({ ...model.album(a), saved: true }));
}

export async function saveAlbum({ id, on }) {
  const uid = await myId();
  await api(`/api/album/${on ? "sub" : "unsub"}`, { id });
  if (savedAlbumIds && savedAlbumIds.uid === uid) on ? savedAlbumIds.ids.add(String(id)) : savedAlbumIds.ids.delete(String(id));
}

export async function followArtist({ id, on }) {
  await myId();
  await api(`/api/artist/${on ? "sub" : "unsub"}`, { artistId: id, artistIds: `[${id}]` });
}

export async function recent() {
  await myId();
  return (await recentInfo()).tracks;
}

// 听歌记录接口不看 limit，一次就回 300 首；音乐库列表只需要封面和总数，
// 所以记一次缓存，避免每次打开音乐库都拉 300 首。
let recentCache = null;

async function recentInfo(force = false) {
  if (!force && recentCache && Date.now() - recentCache.at < 300_000) return recentCache;
  const r = await api("/api/play-record/song/list", { limit: 300 });
  const items = [];
  for (const x of r.data?.list || []) {
    const track = trackOf(x.data);
    if (track) items.push({ track, at: Number(x.playTime) || 0 });
  }
  recentCache = { at: Date.now(), items, tracks: items.map((x) => x.track), total: Number(r.data?.total) || items.length };
  return recentCache;
}

// 每日推荐：首页的大海报和音乐库里的固定歌单用同一份数据，取一次缓存 5 分钟。
let dailyCache = null;

async function dailyInfo(force = false) {
  if (!force && dailyCache && Date.now() - dailyCache.at < 300_000) return dailyCache;
  const r = await api("/api/v3/discovery/recommend/songs");
  const songs = r.data?.dailySongs || [];
  dailyCache = { at: Date.now(), tracks: tracksOf(songs, r.data?.privileges), cover: songs[0]?.al?.picUrl || "" };
  return dailyCache;
}

async function cloudTracks(limit = CLOUD_PAGE) {
  const j = await api("/api/v1/cloud/get", { limit, offset: 0 });
  return (Array.isArray(j.data) ? j.data : []).map(model.cloudTrack);
}

// ── 音乐库里的「系统歌单」 ──
//
// 宿主的音乐库固定四个 tab（歌曲 / 专辑 / 歌单 / 艺人），插件加不了第五个；
// 但「歌单」这一栏显示的就是 playlists() 的返回值，所以把常用的入口做成几份
// 固定在前面的系统歌单。fixed 会让宿主不显示重命名、删除，也不会出现在
// 「加进歌单」的候选列表里。
const SYS_DAILY = "sys-daily";
const SYS_RECENT = "sys-recent";
const SYS_CLOUD = "sys-cloud";

function sysCard(id, name, count, cover, description) {
  return {
    id,
    name,
    description,
    mine: true,
    fixed: true,
    saved: false,
    trackCount: count || undefined,
    imageUrl: cover || undefined,
  };
}

// 云盘卡片（数量 + 第一张封面）也留 60 秒：宿主切标签会重取歌单列表，不该每次都多打一个请求。
let cloudCardCache = null; // { at, count, cover }

async function cloudCard() {
  if (cloudCardCache && Date.now() - cloudCardCache.at < 60_000) return cloudCardCache;
  const j = await api("/api/v1/cloud/get", { limit: 1, offset: 0 });
  const first = j.data?.[0];
  cloudCardCache = {
    at: Date.now(),
    count: Number(j.count) || 0,
    cover: first ? model.cloudTrack(first).album?.imageUrl : undefined,
  };
  return cloudCardCache;
}

// 列表里的卡片只要封面和数量：云盘用 limit=1 拿封面 + count 拿总数，听歌记录和
// 每日推荐走缓存。
async function systemPlaylists() {
  if (!loggedIn()) return []; // 这些接口都要账号
  const [daily, rec, cloud] = await Promise.all([
    dailyInfo().catch(() => null),
    recentInfo().catch(() => null),
    cloudCard().catch(() => null),
  ]);
  const out = [];
  if (daily?.tracks?.length) {
    out.push(sysCard(SYS_DAILY, t("每日推荐"), daily.tracks.length, daily.tracks[0]?.album?.imageUrl, t("每天 6:00 更新")));
  }
  if (rec?.total) {
    out.push(sysCard(SYS_RECENT, t("最近播放"), rec.total, rec.tracks[0]?.album?.imageUrl, t("最近的听歌记录")));
  }
  if (cloud?.count && cloud.cover) {
    out.push(sysCard(SYS_CLOUD, t("我的云盘"), cloud.count, cloud.cover, t("你上传到网易云的音乐")));
  }
  return out;
}

// 一首歌播放了：上报听歌记录。
export async function played({ id }) {
  if (!loggedIn()) return;
  await api("/api/feedback/weblog", {
    logs: JSON.stringify([
      {
        action: "play",
        json: {
          download: 0,
          end: "playend",
          id: Number(id),
          sourceId: "",
          time: durations.get(String(id)) || 240,
          type: "song",
          wifi: 0,
          source: "list",
          mainsite: 1,
          content: "",
        },
      },
    ]),
  });
}

// ── 专辑、歌手、歌单 ──

export async function album({ id }) {
  const uid = loggedIn() ? await myId().catch(() => "") : "";
  const known = uid && savedAlbumIds && savedAlbumIds.uid === uid && savedAlbumIds.complete ? savedAlbumIds.ids.has(String(id)) : null;
  const [r, dyn] = await Promise.all([
    api(`/api/v1/album/${id}`),
    uid && known === null ? api("/api/album/detail/dynamic", { id }).catch(() => null) : null,
  ]);
  if (!r.album) throw new Error(t("找不到这张专辑"));
  const a = model.album(r.album);
  if (known !== null) a.saved = known;
  else if (dyn && typeof dyn.isSub === "boolean") a.saved = dyn.isSub;
  return { album: a, tracks: tracksOf(r.songs) };
}

export async function artist({ id }) {
  // 专辑接口只取前两页（最多 100 张），并用较短超时：弱网下快速返回能拿到的数据，
  // 而不是死等重试拖到调用超时。
  const albumsAt = (offset) =>
    api(`/api/artist/albums/${id}`, { limit: 50, offset, total: true }, { timeout: 8000 }).catch(() => ({}));
  const [d, first, second, sim] = await Promise.all([
    api(`/api/v1/artist/${id}`),
    albumsAt(0),
    albumsAt(50),
    api("/api/discovery/simiArtist", { artistid: id }, { timeout: 5000 }).catch(() => ({})),
  ]);
  if (!d.artist) throw new Error(t("找不到这位歌手"));
  const discs = (first.hotAlbums || []).concat(second.hotAlbums || []);
  const seen = new Set();
  const albums = [];
  for (const x of discs) {
    if (!x || !x.id || seen.has(x.id)) continue;
    seen.add(x.id);
    albums.push(model.album(x));
  }
  return {
    artist: model.artist(d.artist),
    tracks: tracksOf(d.hotSongs),
    albums,
    related: (sim.artists || []).map(model.artist),
  };
}

// 用户的歌单列表。宿主每次切音乐库标签都可能把整份数据重取一次（见 refreshLibrary），
// 而 liked() 和 playlists() 都要它，所以留 60 秒；新建/改名/删除时立刻作废。
let listsCache = null; // { uid, at, list }

async function rawPlaylists(uid) {
  if (listsCache && listsCache.uid === uid && Date.now() - listsCache.at < 60_000) return listsCache.list;
  const all = [];
  for (let i = 0; i < 10; i++) {
    const r = await api("/api/user/playlist", { uid, limit: 1000, offset: all.length, includeVideo: true });
    all.push(...(r.playlist || []));
    if (!r.more || !(r.playlist || []).length) break;
  }
  listsCache = { uid, at: Date.now(), list: all };
  return all;
}

const dropListsCache = () => {
  listsCache = null;
};

export async function playlists() {
  const uid = await myId();
  const [mine, sys] = await Promise.all([rawPlaylists(uid), systemPlaylists()]);
  return [...sys, ...mine.map((x) => model.playlist(x, uid))];
}

// 歌单和它的全部歌曲：按歌单里的顺序，带上每首歌加入歌单的时间。
async function playlistDetail(id) {
  const r = await api("/api/v6/playlist/detail", { id, n: 100000, s: 8 });
  const p = r.playlist;
  if (!p) throw new Error(t("找不到这个歌单"));
  const entries = p.trackIds || [];
  const have = new Map(tracksOf(p.tracks, r.privileges).map((x) => [x.id, x]));
  const missing = entries.map((e) => String(e.id)).filter((x) => !have.has(x));
  for (const tr of await songDetails(missing)) have.set(tr.id, tr);
  let tracks;
  if (entries.length) {
    tracks = [];
    for (const e of entries) {
      const tr = have.get(String(e.id));
      if (tr) tracks.push({ ...tr, added: typeof e.at === "number" && e.at > 0 ? new Date(e.at).toISOString() : undefined });
    }
  } else {
    tracks = [...have.values()];
  }
  return { p, tracks };
}

export async function playlist({ id }) {
  // 右键「歌曲信息」打开的伪歌单：一个页面装一首歌 + 多行简介。
  if (String(id).startsWith(INFO_PREFIX)) {
    const d = await songDetail(String(id).slice(INFO_PREFIX.length));
    const tr = d.track;
    return {
      id,
      name: d.song.name,
      description: d.lines.join("\n"),
      owner: (d.song.ar || []).map((a) => a.name).join(" / "),
      imageUrl: tr?.album?.imageUrl,
      trackCount: 1,
      mine: false,
      saved: false,
      fixed: true,
      tracks: tr ? [tr] : [],
    };
  }

  if (loggedIn()) await myId().catch(() => {}); // 需要知道「我」是谁才能判断是不是自己的歌单

  // 音乐库里的系统歌单：点开时现取，歌单列表里只放卡片所需的信息。
  if (id === SYS_DAILY) {
    const d = await dailyInfo(true);
    if (!d.tracks.length) throw new Error(t("这里还没有内容"));
    const cover = d.tracks[0]?.album?.imageUrl;
    return { ...sysCard(id, t("每日推荐"), d.tracks.length, cover, t("每天 6:00 更新")), tracks: d.tracks };
  }
  if (id === SYS_RECENT) {
    const info = await recentInfo(true);
    if (!info.tracks.length) throw new Error(t("这里还没有内容"));
    const cover = info.tracks[0]?.album?.imageUrl;
    return { ...sysCard(id, t("最近播放"), info.tracks.length, cover, t("最近的听歌记录")), tracks: info.tracks };
  }
  if (id === SYS_CLOUD) {
    const tracks = await cloudTracks();
    if (!tracks.length) throw new Error(t("这里还没有内容"));
    const cover = tracks.find((x) => x.album?.imageUrl)?.album.imageUrl;
    return { ...sysCard(id, t("我的云盘"), tracks.length, cover, t("你上传到网易云的音乐")), tracks };
  }

  const { p, tracks } = await playlistDetail(id);
  return { ...model.playlist(p, me?.id || ""), trackCount: tracks.length || undefined, tracks };
}

export async function savePlaylist({ id, on }) {
  await myId();
  await api(`/api/playlist/${on ? "subscribe" : "unsubscribe"}`, { id });
  dropListsCache();
}

export async function createPlaylist({ name }) {
  await myId();
  const r = await api("/api/playlist/create", { name, privacy: 0, type: "NORMAL" });
  dropListsCache();
  if (!r.playlist) throw new Error(r.message || t("歌单没建成"));
  return { ...model.playlist(r.playlist, me.id), mine: true, saved: false, fixed: false };
}

export async function renamePlaylist({ id, name }) {
  await myId();
  await api("/api/playlist/update/name", { id, name });
  dropListsCache();
}

export async function deletePlaylist({ id }) {
  await myId();
  await api("/api/playlist/remove", { ids: `[${id}]` });
  dropListsCache();
}

async function manipulate(op, id, trackIds) {
  await myId();
  await api("/api/playlist/manipulate/tracks", { op, pid: id, trackIds: JSON.stringify((trackIds || []).map(String)), imme: "true" });
}

export async function addToPlaylist({ id, trackIds }) {
  await manipulate("add", id, trackIds);
}

export async function removeFromPlaylist({ id, trackIds }) {
  await manipulate("del", id, trackIds);
}

// ── 播放 ──

const LEVELS = { hires: "hires", lossless: "lossless", high: "exhigh", standard: "standard" };
const LEVEL_ORDER = ["hires", "lossless", "high", "standard"];

export async function stream({ id, quality = "high" }) {
  const setting = typeof host.setting === "function" ? host.setting("quality") : "";
  const selected = LEVEL_ORDER.includes(setting) ? setting : LEVEL_ORDER.includes(quality) ? quality : "high";
  const songId = Number(id);
  // 从所选档位往下尝试，没有完整音频时自动降级，不会用试听片段冒充完整歌曲。
  for (const candidate of LEVEL_ORDER.slice(LEVEL_ORDER.indexOf(selected))) {
    const level = LEVELS[candidate];
    const r = await api("/api/song/enhance/player/url/v1", { ids: JSON.stringify([songId]), level, encodeType: "flac" });
    const d = (r.data || [])[0];
    if (!d?.url || d.freeTrialInfo) continue;
    return {
      url: d.url.replace(/^http:/, "https:"),
      type: d.type ? String(d.type).toLowerCase() : undefined,
      quality: d.level || level,
      bitRate: d.br ? Math.round(d.br / 1000) : undefined,
      size: d.size || undefined,
    };
  }
  throw fail(
    "unavailable",
    loggedIn() ? t("这首歌放不了（无版权、仅限 VIP 或需单独购买）") : t("这首歌放不了，登录后再试试")
  );
}

export async function lyrics({ id }) {
  const r = await api("/api/song/lyric", { id, tv: -1, lv: -1, kv: -1, rv: -1 });
  return { lrc: r.lrc?.lyric || "", translation: r.tlyric?.lyric || undefined };
}

export async function similar({ id }) {
  const r = await api("/api/v1/discovery/simiSong", { songid: id, limit: 50, offset: 0 });
  return (r.songs || []).map((s) => trackOf(s)).filter(Boolean);
}

export async function station({ id }) {
  if (id !== "fm") return { tracks: [] };
  await myId();
  const r = await api("/api/v1/radio/get");
  return { tracks: (r.data || []).map((s) => trackOf(s)).filter(Boolean), more: true };
}

export async function dislike({ id }) {
  await myId();
  await api("/api/radio/trash/add", { songId: id, alg: "RT", time: 25 });
}

// ── 评论 ──

function commentOf(c) {
  const reply = (c.beReplied || [])[0];
  return {
    id: String(c.commentId),
    text: c.content || "",
    user: c.user ? { id: String(c.user.userId), name: c.user.nickname || "", imageUrl: c.user.avatarUrl || undefined } : undefined,
    time: c.time,
    likes: c.likedCount,
    liked: c.liked === true,
    replyTo: reply
      ? { id: String(reply.beRepliedCommentId ?? ""), user: { name: reply.user?.nickname || "" }, text: reply.content || "" }
      : undefined,
  };
}

export async function comments({ id, sort = "hot", offset = 0 }) {
  const limit = 30;
  if (sort === "hot") {
    const r = await api(`/api/v1/resource/hotcomments/R_SO_4_${id}`, { rid: id, limit, offset, beforeTime: 0 });
    return { comments: (r.hotComments || []).map(commentOf), total: r.total, more: !!r.hasMore };
  }
  const r = await api(`/api/v1/resource/comments/R_SO_4_${id}`, { rid: id, limit, offset, beforeTime: 0 });
  return { comments: (r.comments || []).map(commentOf), total: r.total, more: !!r.more };
}

export async function postComment({ id, text, replyTo }) {
  await myId();
  const threadId = `R_SO_4_${id}`;
  const r = replyTo
    ? await api("/api/resource/comments/reply", { threadId, content: text, commentId: replyTo })
    : await api("/api/resource/comments/add", { threadId, content: text });
  return r.comment ? commentOf(r.comment) : null;
}

export async function likeComment({ id, commentId, on }) {
  await myId();
  await api(`/api/v1/comment/${on ? "like" : "unlike"}`, { threadId: `R_SO_4_${id}`, commentId });
}

// ── 歌曲右键菜单 ──

// ── 歌曲信息（右键） ──
//
// 播放页的四个栏目（歌词 / 评论 / 队列 / 相似）在宿主里是固定的枚举值，插件加不了
// 第五个；但播放页和所有列表都挂了歌曲右键菜单，所以「歌曲信息」只能从这里进。
// 网易云没有「录音室 / 现场」这种字段，版本是按歌名、专辑名、别名里的关键词推的。

const INFO_ACTION = "song-info";
const INFO_PREFIX = "info-";

const VERSION_HINTS = [
  [/(unplugged|不插电|不插電)/i, "不插电"],
  [/(\blive\b|现场|現場|演唱会|演唱會)/i, "现场版"],
  [/(instrumental|karaoke|off ?vocal|伴奏|纯音乐|純音樂)/i, "伴奏 / 纯音乐"],
  [/(acoustic|原声版|原聲版)/i, "原声版"],
  [/(remix|混音)/i, "混音版"],
  [/(\bdemo\b)/i, "Demo"],
  [/(cover|翻唱)/i, "翻唱"],
];

function versionOf(s) {
  const text = [s.name, s.al?.name, ...(s.alia || []), ...(s.tns || [])].filter(Boolean).join(" ");
  for (const [re, label] of VERSION_HINTS) if (re.test(text)) return t(label);
  return "";
}

function dateText(ms) {
  if (typeof ms !== "number" || !ms) return "";
  const d = new Date(ms + 8 * 3600 * 1000); // 网易云的日期是北京时间零点
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

async function songDetail(id) {
  const r = await api("/api/v3/song/detail", { c: JSON.stringify([{ id: Number(id) }]) });
  const s = (r.songs || [])[0];
  if (!s) throw new Error(t("找不到这首歌的信息"));

  // 唱片公司只有专辑接口里有，取不到就不写这一行。
  const albumDetail = s.al?.id
    ? await api(`/api/v1/album/${s.al.id}`, {}, { timeout: 6000 }).catch(() => null)
    : null;
  const company = albumDetail?.album?.company || "";
  const version = versionOf(s);
  const release = dateText(s.publishTime);
  const alias = [...(s.alia || []), ...(s.tns || [])].filter(Boolean);
  const mm = s.dt ? `${Math.floor(s.dt / 60000)}:${String(Math.floor((s.dt % 60000) / 1000)).padStart(2, "0")}` : "";

  const lines = [
    release ? `${t("发行")}：${release}` : "",
    s.al?.name ? `${t("专辑")}：《${s.al.name}》${s.no ? ` · #${s.no}` : ""}` : "",
    version ? `${t("版本")}：${version}（${t("据名称判断")}）` : "",
    company ? `${t("唱片公司")}：${company}` : "",
    mm ? `${t("时长")}：${mm}` : "",
    alias.length ? `${t("别名")}：${alias.join(" / ")}` : "",
    s.mv ? `MV：https://music.163.com/mv?id=${s.mv}` : "",
    `https://music.163.com/song?id=${s.id}`,
  ].filter(Boolean);

  return { song: s, lines, track: trackOf(s) };
}

export function trackMenu() {
  return [
    { id: INFO_ACTION, title: t("歌曲信息"), icon: "info" },
    { id: "open-netease", title: t("在网易云音乐网页打开") },
  ];
}

export async function menuAction({ id: action, track }) {
  // 弹一行提示或只进剪贴板都不够用，改成打开一个真正的页面：
  // 歌单详情页会把 description 渲染成可展开的简介文本，正好拿来放歌曲信息。
  if (action === INFO_ACTION) {
    return { open: { kind: "playlist", id: `${INFO_PREFIX}${track.id}` } };
  }
  if (action !== "open-netease") fail("unsupported", "未知的菜单操作");
  host.openURL(`https://music.163.com/song?id=${track.id}`);
  return {};
}

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
      const r = await twice(() =>
        api("/api/v3/song/detail", { c: JSON.stringify(chunk.map((id) => ({ id: Number(id) }))) })
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
}

export async function profile() {
  const uid = await myId();
  const [r, lists, week] = await Promise.all([
    api(`/api/v1/user/detail/${uid}`),
    rawPlaylists(uid),
    api("/api/v1/play/record", { uid, type: 1 }).catch(() => null), // 最近一周听得最多
  ]);
  const p = r.profile || {};
  const mine = (lists || []).map((x) => model.playlist(x, uid)).filter((x) => x.mine);
  const top = (week?.weekData || [])
    .slice(0, 20)
    .map((x) => {
      const tr = trackOf(x.song);
      return tr ? { ...tr, plays: x.playCount || 0 } : null;
    })
    .filter(Boolean);
  return {
    name: p.nickname || me.name,
    imageUrl: p.avatarUrl || undefined,
    signature: p.signature || undefined,
    badges: r.level ? [`Lv.${r.level}`] : [],
    facts: [
      { label: t("关注"), value: String(p.follows ?? 0) },
      { label: t("粉丝"), value: String(p.followeds ?? 0) },
    ],
    stats: [
      { label: t("累计听歌"), value: r.listenSongs ?? 0, link: "songs" },
      { label: t("歌单"), value: mine.length, link: "playlists" },
    ],
    topTracks: top.length ? { title: t("最近一周最常听"), tracks: top } : undefined,
    playlists: mine,
  };
}

// ── 发现 ──

export async function home() {
  const signed = loggedIn();
  const quiet = (p, label) =>
    p.catch((e) => {
      console.warn(label, e.message || e);
      return null;
    });
  const [daily, rec, fresh, discs, charts] = await Promise.all([
    signed ? quiet(api("/api/v3/discovery/recommend/songs"), "daily") : null,
    quiet(
      signed ? api("/api/v1/discovery/recommend/resource") : api("/api/personalized/playlist", { limit: 30, total: true, n: 1000 }),
      "recommend"
    ),
    quiet(api("/api/personalized/newsong", { type: "recommend", limit: 12, areaId: 0 }), "newsong"),
    quiet(api("/api/discovery/newAlbum", { area: "ALL", limit: 20, offset: 0, total: true }), "newalbum"),
    quiet(api("/api/toplist"), "toplist"),
  ]);
  if (!rec && !fresh && !discs && !charts) throw new Error(t("连不上网易云音乐"));

  const sections = [];
  const modes = [];
  if (signed) {
    const songs = daily?.data?.dailySongs || [];
    if (songs.length) {
      modes.push({
        title: t("每日推荐"),
        subtitle: t("每天 6:00 更新"),
        imageUrl: songs[0]?.al?.picUrl || undefined,
        tracks: tracksOf(songs, daily.data.privileges),
      });
    }
    modes.push({ title: t("私人 FM"), subtitle: t("根据你的口味一直放下去"), station: "fm" });
  }
  if (modes.length) sections.push({ style: "modes", modes });

  const lists = (rec?.recommend || rec?.result || []).map((x) => model.playlist(x, me?.id || ""));
  if (lists.length) sections.push({ title: t("推荐歌单"), style: "shelf", playlists: lists });

  const tracks = (fresh?.result || []).map((x) => trackOf(x.song)).filter(Boolean);
  if (tracks.length) sections.push({ title: t("新歌速递"), style: "songs", tracks });

  const albums = (discs?.albums || []).map(model.album);
  if (albums.length) sections.push({ title: t("新碟上架"), style: "shelf", albums });

  const top = (charts?.list || []).map((x) => model.playlist(x, me?.id || "")).slice(0, 4);
  if (top.length) sections.push({ title: t("排行榜"), style: "shelf", playlists: top, morePage: "charts" });

  return { title: t("网易云音乐"), sections };
}

const CATS = ["全部", "华语", "流行", "欧美", "日语", "韩语", "摇滚", "民谣", "电子", "说唱", "轻音乐", "ACG", "古风", "古典", "爵士", "影视原声"];

export async function browse({ page } = {}) {
  // 排行榜
  if (page === "charts") {
    const r = await api("/api/toplist");
    return { title: t("排行榜"), sections: [{ style: "grid", playlists: (r.list || []).map((x) => model.playlist(x, me?.id || "")) }] };
  }
  // 我的云盘（登录后）
  if (page === "cloud" || page.startsWith("cloud:")) {
    const uid = await myId();
    const rawOffset = page === "cloud" ? "0" : page.slice(6);
    const offset = /^\d+$/.test(rawOffset) ? Number(rawOffset) : 0;
    const j = await api("/api/v1/cloud/get", { limit: PAGE, offset });
    const data = Array.isArray(j.data) ? j.data : [];
    const next = offset + data.length;
    const more = data.length > 0 && (j.hasMore == null ? Number(j.count) > next : j.hasMore === true || j.hasMore === 1);
    const sections = [{ title: t("我的云盘"), tracks: data.map(model.cloudTrack), empty: t("云盘中还没有歌曲") }];
    const links = [];
    if (offset > 0) links.push({ title: t("上一页"), page: `cloud:${Math.max(0, offset - PAGE)}` });
    if (more) links.push({ title: t("下一页"), page: `cloud:${next}` });
    if (links.length) sections.push({ links });
    return { title: t("我的云盘"), sections };
  }
  // 发现：分类歌单
  const cat = page && page.startsWith("cat:") ? page.slice(4) : "全部";
  const r = await api("/api/playlist/list", { cat, order: "hot", limit: 60, offset: 0, total: true });
  return {
    title: t("发现"),
    tabs: CATS.map((c) => ({ title: t(c), page: `cat:${c}`, selected: c === cat })),
    sections: [
      { style: "grid", playlists: (r.playlists || []).map((x) => model.playlist(x, me?.id || "")) },
      { title: t("排行榜"), links: [{ title: t("全部排行榜"), page: "charts" }] },
    ],
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

export async function liked({ offset = 0 } = {}) {
  const ids = await likedList(offset === 0);
  const start = offsetOf(offset);
  const page = ids.slice(start, start + LIKED_PAGE);
  return { tracks: await songDetails(page), more: start + page.length < ids.length };
}

export async function isLiked({ ids }) {
  if (!loggedIn()) return {};
  const set = new Set(await likedList());
  return Object.fromEntries((ids || []).map((id) => [id, set.has(String(id))]));
}

export async function like({ id, on }) {
  const uid = await myId();
  await api("/api/radio/like", { alg: "itembased", trackId: Number(id), like: !!on, time: "3" });
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
  const r = await api("/api/play-record/song/list", { limit: 100 });
  return (r.data?.list || []).map((x) => trackOf(x.data)).filter(Boolean);
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

async function rawPlaylists(uid) {
  const all = [];
  for (let i = 0; i < 10; i++) {
    const r = await api("/api/user/playlist", { uid, limit: 1000, offset: all.length, includeVideo: true });
    all.push(...(r.playlist || []));
    if (!r.more || !(r.playlist || []).length) break;
  }
  return all;
}

export async function playlists() {
  const uid = await myId();
  return (await rawPlaylists(uid)).map((x) => model.playlist(x, uid));
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
  if (loggedIn()) await myId().catch(() => {}); // 需要知道「我」是谁才能判断是不是自己的歌单
  const { p, tracks } = await playlistDetail(id);
  return { ...model.playlist(p, me?.id || ""), trackCount: tracks.length || undefined, tracks };
}

export async function savePlaylist({ id, on }) {
  await myId();
  await api(`/api/playlist/${on ? "subscribe" : "unsubscribe"}`, { id });
}

export async function createPlaylist({ name }) {
  await myId();
  const r = await api("/api/playlist/create", { name, privacy: 0, type: "NORMAL" });
  if (!r.playlist) throw new Error(r.message || t("歌单没建成"));
  return { ...model.playlist(r.playlist, me.id), mine: true, saved: false, fixed: false };
}

export async function renamePlaylist({ id, name }) {
  await myId();
  await api("/api/playlist/update/name", { id, name });
}

export async function deletePlaylist({ id }) {
  await myId();
  await api("/api/playlist/remove", { ids: `[${id}]` });
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

export function trackMenu() {
  return [{ id: "open-netease", title: t("在网易云音乐网页打开") }];
}

export function menuAction({ id: action, track }) {
  if (action !== "open-netease") fail("unsupported", "未知的菜单操作");
  host.openURL(`https://music.163.com/song?id=${track.id}`);
  return {};
}

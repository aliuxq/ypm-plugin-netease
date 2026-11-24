// 网易云原始数据 → YesPlayMusic 插件数据结构的转换。
import { t } from "./i18n.js";

// 网易云用 id 0 表示「没有这个歌手 / 专辑」（用户上传、未收录的歌）。宿主拿到非空 id
// 就会给它做跳转链接，因此这种情况统一转成空串。
const sid = (x) => {
  const s = String(x ?? "");
  return s && s !== "0" ? s : "";
};

// 网易云给没有头像的歌手用的占位图，不当作真实封面。
const PLACEHOLDER_PICS = ["18686200114669622", "5639395138885805"];

function image(url, size = 512) {
  if (!url) return undefined;
  const s = String(url);
  if (PLACEHOLDER_PICS.some((x) => s.includes(x))) return undefined;
  const https = s.replace(/^http:/, "https:");
  return `${https}${https.includes("?") ? "&" : "?"}param=${size}y${size}`;
}

// 网易云的日期是北京时间零点的毫秒时间戳，按 UTC+8 取年月日（直接取 UTC 会早一天）。
function dateOf(ms) {
  if (typeof ms !== "number" || !ms) return undefined;
  const d = new Date(ms + 8 * 3600 * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

const timeOf = (ms) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : undefined);

export function artist(x = {}) {
  return {
    id: sid(x.id),
    name: x.name || t("未知歌手"),
    imageUrl: image(x.img1v1Url || x.picUrl || x.avatar || x.cover),
    following: typeof x.followed === "boolean" ? x.followed : undefined,
  };
}

// 网易云把单曲和 EP 都标成 "EP/Single"，这里按曲目数分开，供宿主的「专辑 / 单曲与 EP」分类用。
function albumKind(x) {
  const type = String(x.type || "").toLowerCase();
  if (type === "single") return "single";
  if (type === "ep") return "ep";
  if (type.includes("single") || type.includes("ep")) return (x.size || 0) > 3 ? "ep" : "single";
  if (type.includes("精选") || type.includes("合集")) return "compilation";
  return "album";
}

export function album(x = {}) {
  const artists = x.artists?.length ? x.artists : x.artist ? [x.artist] : [];
  return {
    id: sid(x.id),
    name: x.name || t("未知专辑"),
    imageUrl: image(x.picUrl || x.blurPicUrl),
    artists: artists.map(artist),
    released: dateOf(x.publishTime),
    kind: albumKind(x),
    trackCount: x.size ?? x.songCount ?? undefined,
    copyright: x.company ? `℗ ${x.company}` : undefined,
    saved: typeof x.isSub === "boolean" ? x.isSub : undefined,
  };
}

export function track(x = {}, privilege = {}) {
  if (!x || !x.id) return null;
  const p = privilege || x.privilege || {};
  const id = String(x.id);
  return {
    id,
    name: x.name || t("未知歌曲"),
    artists: (x.ar || x.artists || []).map(artist),
    album: album(x.al || x.album || {}),
    duration: x.dt ?? x.duration ?? undefined,
    url: `https://music.163.com/song?id=${id}`,
    // st < 0：下架或无版权；pl === 0 且非云盘：这个账号放不了（VIP / 数字专辑）。
    unavailable: p.st < 0 || (p.pl === 0 && !p.cs),
  };
}

export function playlist(x = {}, userId = "") {
  const ownerId = sid(x.creator?.userId ?? x.userId);
  const mine = Boolean(userId) && ownerId === userId;
  return {
    id: sid(x.id),
    name: x.name || t("未命名歌单"),
    imageUrl: image(x.coverImgUrl || x.picUrl || x.coverUrl),
    description: x.description || x.copywriter || undefined,
    owner: x.creator?.nickname || undefined,
    trackCount: x.trackCount ?? x.tracks?.length ?? undefined,
    plays: x.playCount ?? x.playcount ?? undefined,
    mine,
    saved: !mine && x.subscribed === true,
    fixed: mine && x.specialType === 5,
  };
}

// 云盘歌曲：编号优先取上传记录的 songId，公开曲库下架不代表自己的云盘文件不可播。
export function cloudTrack(x = {}) {
  const song = x.simpleSong && typeof x.simpleSong === "object" ? x.simpleSong : {};
  const songId = [x.songId, song.id].map(sid).find((v) => /^\d+$/.test(v) && !/^0+$/.test(v)) || "";
  const mapped = track({
    ...song,
    id: songId,
    name: x.songName || song.name || x.fileName,
    ar: song.ar?.length ? song.ar : song.artists?.length ? song.artists : [{ name: x.artist || t("未知歌手") }],
    al: {
      ...(song.al || song.album || {}),
      name: x.album || song.al?.name || song.album?.name || t("未知专辑"),
      picUrl: x.cover || song.al?.picUrl || song.album?.picUrl,
    },
  });
  return { ...mapped, unavailable: !songId };
}

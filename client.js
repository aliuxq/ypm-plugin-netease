// 网易云音乐 eapi 客户端。
//
// 本插件不依赖任何第三方库，也不自带 Node.js 运行时——所有请求都走网易云 PC 客户端
// 使用的 eapi 接口：参数用 AES-128-ECB 加密，签名用 MD5，两者均由宿主提供的 host.crypto
// 提供，因此在 QuickJS 运行环境里也无需自己实现 RSA / AES-CBC。
//
// Cookie（含登录态）只发往 interface.music.163.com，不会交给音频 CDN，也不会打印到日志。

import { t } from "./i18n.js";

const BASE = "https://interface.music.163.com";
const KEY = "e82ckenh8dichen8";
const SEP = "-36cd479b6b5-";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.17.204416";
const APPVER = "3.1.17.204416";
const TIMEOUT = 20000;

// 抛出一个带错误码的异常；code 会被宿主识别（signIn / unavailable / unsupported …）。
export function fail(code, message, retryable = false) {
  throw Object.assign(new Error(t(message)), { code, retryable });
}

// ── Cookie / 会话 ──

function parseCookie(text) {
  const jar = {};
  for (const part of String(text || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return jar;
}

export function session() {
  return host.storage.get("cookies") || {};
}

export function hasSession() {
  return Boolean(session().MUSIC_U);
}

export function currentAccount() {
  return host.storage.get("account") || null;
}

// 清掉本插件的全部登录态（不影响用户在浏览器 / 官方客户端里的登录）。
export function resetSession() {
  host.storage.set("sessionEpoch", (host.storage.get("sessionEpoch") || 0) + 1);
  for (const key of ["cookies", "account", "likedIds", "likedAt", "savedAlbumIds"]) host.storage.remove(key);
}

function epoch() {
  return host.storage.get("sessionEpoch") || 0;
}

function deviceId() {
  let id = host.storage.get("deviceId");
  if (!id) {
    id = "";
    for (let i = 0; i < 52; i++) id += "0123456789ABCDEF"[Math.floor(Math.random() * 16)];
    host.storage.set("deviceId", id);
  }
  return id;
}

function encodeCookie(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// ── eapi 加密 ──

// path 形如 "/api/xxx"；签名与加密都基于这个路径，请求时才改写到 /eapi/xxx。
function eapiParams(path, data) {
  const text = JSON.stringify(data);
  const digest = host.crypto.md5(`nobody${path}use${text}md5forencrypt`);
  const msg = `${path}${SEP}${text}${SEP}${digest}`;
  return host.crypto.aesEcbEncrypt(KEY, msg).toUpperCase();
}

// 构造一次请求要带的 header 对象（会同时放进加密 body 和 Cookie 请求头）。
function requestHeader(jar) {
  return {
    os: "pc",
    appver: APPVER,
    deviceId: deviceId(),
    osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
    channel: "netease",
    versioncode: "140",
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: "1920x1080",
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
    __csrf: jar.__csrf || "",
    MUSIC_U: jar.MUSIC_U || "",
  };
}

// 通用请求。options：
//   cookies   — 用指定的 Cookie 而不是当前会话（登录流程用）
//   raw       — true 时不检查返回码，把 { result, cookies } 原样返回
//   persist   — false 时不把响应里的 Set-Cookie 写回存储（登录流程用）
//   withCookies — true 时返回 { result, cookies }
export async function api(path, data = {}, options = {}) {
  if (!/^\/api\/[A-Za-z0-9/_-]+$/.test(path)) fail("failed", "无效的接口路径");
  const jar = options.cookies ?? session();
  const header = requestHeader(jar);
  const body = new URLSearchParams({ params: eapiParams(path, { ...data, header, e_r: false }) });

  let response;
  try {
    response = await fetch(BASE + path.replace(/^\/api\//, "/eapi/"), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        Referer: "https://music.163.com/",
        Cookie: encodeCookie({ ...jar, ...header, NMTID: jar.NMTID || "" }),
      },
      body,
      signal: AbortSignal.timeout(options.timeout ?? TIMEOUT),
    });
  } catch (e) {
    fail("failed", t("连不上网易云音乐，请检查网络后重试"), true);
  }

  if (!response.ok) {
    if (response.status === 401) fail("signIn", "网易云登录已失效，请重新登录");
    fail("failed", t("网易云服务暂时不可用（HTTP {status}），请稍后重试", { status: response.status }), response.status === 429 || response.status >= 500);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    fail("failed", "网易云返回了无法识别的响应，请稍后重试", true);
  }

  // 从响应头收集 Set-Cookie（扫码登录成功后 MUSIC_U 就来自这里）。
  const cookies = { ...jar };
  for (const line of response.headers.getSetCookie()) {
    Object.assign(cookies, parseCookie(line.split(";", 1)[0]));
  }

  const code = Number(result.code ?? 200);
  if (!options.raw && code !== 200) {
    if ([301, 302, 401].includes(code)) fail("signIn", "网易云登录已失效，请重新登录");
    if (code === -462 || code === 405) fail("failed", "网易云要求安全验证，请先在网易云官方客户端完成验证后再试");
    fail("failed", t("网易云请求失败（{code}）：{message}", {
      code,
      message: String(result.message || result.msg || "请稍后重试").slice(0, 180),
    }));
  }

  // 退出登录后，旧的在途请求不能把已清除的会话写回来。
  if (options.persist !== false && epoch() === (options.epoch ?? epoch())) {
    const current = session();
    for (const line of response.headers.getSetCookie()) {
      Object.assign(current, parseCookie(line.split(";", 1)[0]));
    }
    host.storage.set("cookies", current);
  }

  return options.withCookies ? { result, cookies } : result;
}

// 用现有 Cookie 校验账号，并把解析好的账号信息缓存起来。
export async function verify() {
  const at = epoch();
  const { result, cookies } = await api("/api/w/nuser/account/get", {}, {
    persist: false,
    withCookies: true,
  });
  if (epoch() !== at) fail("signIn", "登录状态已变化，请重新扫码");
  const p = result.profile;
  if (!p?.userId || !cookies.MUSIC_U) fail("signIn", "无法确认网易云账号，请重新登录");
  const account = { id: String(p.userId), name: p.nickname || t("网易云用户"), imageUrl: p.avatarUrl || "" };
  host.storage.set("cookies", cookies);
  const old = currentAccount();
  if (old?.id !== account.id) {
    host.storage.remove("likedIds");
    host.storage.remove("likedAt");
    host.storage.remove("savedAlbumIds");
  }
  host.storage.set("account", account);
  return account;
}

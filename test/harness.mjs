// 在 Node 里模拟 YesPlayMusic 的插件运行环境（host.*），不登录直接调插件的某个函数，
// 对真实的网易云接口做冒烟测试。
//
// 用法：
//   node test/harness.mjs                       列出插件导出的函数
//   node test/harness.mjs search '{"query":"海屿你"}'
//   node test/harness.mjs playlist '{"id":"3778678"}'
//   node test/harness.mjs hotSearches
//
// 状态（随机生成的设备号）存在 test/.storage.json，不进仓库。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, "..");
const dataFile = path.join(here, ".storage.json");

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    return {};
  }
};
const save = (s) => fs.writeFileSync(dataFile, JSON.stringify(s, null, 2));

globalThis.host = {
  platform: process.platform === "win32" ? "windows" : process.platform,
  arch: process.arch === "x64" ? "amd64" : process.arch,
  dir: pluginDir,
  dataDir: here,
  storage: {
    get: (k) => load()[k] ?? null,
    set: (k, v) => save({ ...load(), [k]: v }),
    remove: (k) => {
      const s = load();
      delete s[k];
      save(s);
    },
  },
  setting: (k) => (k === "cookie" ? process.env.NCM_COOKIE || "" : ""),
  language: () => "zh-CN",
  t: (s) => s,
  openURL: (u) => console.log("[openURL]", u),
  crypto: {
    md5: (s) => crypto.createHash("md5").update(String(s), "utf8").digest("hex"),
    aesEcbEncrypt: (key, text) => {
      const c = crypto.createCipheriv(`aes-${Buffer.byteLength(key) * 8}-ecb`, Buffer.from(key, "utf8"), null);
      return Buffer.concat([c.update(String(text), "utf8"), c.final()]).toString("hex");
    },
  },
  signInPrompt: ({ qr, text }) => console.log("[signInPrompt]", text || "", qr || ""),
  webSignIn: () => Promise.reject(new Error("unsupported")),
};

const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
const [, , name, arg] = process.argv;

if (!name) {
  console.log("导出函数:", Object.keys(mod).join(" "));
  process.exit(0);
}
if (typeof mod[name] !== "function") {
  console.error(`插件没有导出 ${name}`);
  process.exit(2);
}

try {
  const out = await mod[name](arg ? JSON.parse(arg) : {});
  JSON.parse(JSON.stringify(out ?? null)); // 返回值必须能 JSON 序列化
  const s = JSON.stringify(out, null, 1);
  console.log(s && s.length > 4000 ? s.slice(0, 4000) + `\n…（共 ${s.length} 个字符）` : s);
} catch (e) {
  console.error("ERROR", e.code || "", e.message);
  process.exit(1);
}

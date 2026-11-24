# 开发说明

面向修改代码或排查问题的场景。日常使用参见 [README](README.md)。

## 文件结构

```
index.js          插件本体：导出的函数名对应应用调用的操作名
plugin.json       清单：权限、设置项、功能入口
client.js         eapi 客户端：请求加密、会话管理
models.js         网易云数据 → 插件数据结构的转换
i18n.js           host.t 的封装（支持 {占位符} 插值）
locales/          界面文案翻译
test/             在 Node 中模拟应用 host 环境运行插件
```

无需构建。修改后将文件放入应用插件目录，在「设置 → 插件」中点击「重新加载」。

```bash
node test/harness.mjs                       # 列出插件导出的函数
node test/harness.mjs search '{"query":"海屿你"}'
node test/harness.mjs playlist '{"id":"3778678"}'
```

## 实现说明

**请求通道**：走网易云 PC 客户端的 eapi 接口，加密使用应用提供的 `host.crypto`（MD5 + AES-128-ECB），不引入第三方库，也无需自行实现 RSA。

**空 id**：网易云用 id `0` 表示「无此歌手 / 专辑」，插件统一转为空串，避免生成无法打开的链接。

**返回类型**：`savedAlbums` 必须返回纯数组，3.0.0 的音乐库页直接按数组消费。

**页面协议**：实际参与渲染的只有 `sections[].style`（`modes` / `shelf` / `songs` / `charts` / `grid`）、`tabs`、`filters` 三项。`Browse` 的 `title` / `description` / `imageUrl`，`Section` 的 `links` / `morePage` / `empty` 均不会被绘制。同理 `plugin.json` 的 `navigation` 不出现在侧边栏，因此排行榜、云盘等二级页通过发现页的大卡与分类标签进入。

**音乐库歌曲栏**：按 `added` 倒序排列并按月分组。`liked()` 必须随歌曲返回加入时间，否则整页会归入单个「更早」分组，日期列留空。

**榜单与新碟**：`/api/toplist` 的 `tracks` 为 `null`，卡内曲目需单独获取；`/api/discovery/newAlbum` 每次仅返回 12 张且 `offset` 无效，新碟墙改用 `/api/album/new`。

**听歌记录**：`/api/play-record/song/list` 忽略 `limit` 与 `offset`，固定返回最近 300 条，因此不支持月视图与年视图。

**切标签重取**：`AppState.replace()` 每次切换标签都会调用 `_refreshLibraryIfShown()`，仅按「30 秒内已取」节流。插件为红心歌曲、歌单列表、云盘卡片增加 45–60 秒缓存，将该步骤耗时降至原十分之一左右。

**无界面入口的操作**：`profile`、`savePlaylist`、`renamePlaylist`、`deletePlaylist`、`suggest`、`played` 在插件侧已实现，但 `lib/` 中没有界面调用点。应用后续补充入口即可生效，插件无需改动。

## 已知现象

**「艺人」栏目卡顿**：应用将曲库中出现过的歌手渲染为气泡，逐个下载头像图，曲目数量较大时会明显卡顿，严重时窗口无响应。该栏目在应用内固定，插件仅提供数据，无法影响渲染方式。

**Windows 原生崩溃**：本机曾多次记录到 `0xc0000374`（堆损坏）、`BEX64`、`0xc0000005`（访问冲突），故障模块为 `unknown`、偏移 `0x0`。同一签名自插件 v1.0.0 起持续出现，不随版本变化。向应用作者反馈时附上错误码更有参考价值。

**封面分辨率**：曾降低封面图分辨率以缓解加载压力，但歌曲页与歌词页的封面清晰度下降明显，因此维持原分辨率。

## 授权

基于 [lymzzyh/ypm-plugin-netease](https://github.com/lymzzyh/ypm-plugin-netease) 与 [limnea/ypm-plugin-netease](https://github.com/limnea/ypm-plugin-netease)（均为 MIT）改编，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。本项目以 [MIT](./LICENSE) 授权。

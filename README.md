# 网易云音乐 for YesPlayMusic

[English](./README.en.md) · 简体中文

YesPlayMusic 3.0 的第三方网易云音乐音乐源插件。安装并登录后，可在应用内使用账号下的歌单、红心歌曲、收藏专辑、每日推荐与私人 FM。

非官方项目，与网易公司及 YesPlayMusic 作者无隶属关系。

## 功能

- **首页**：每日推荐、私人 FM、排行榜、推荐歌单、新碟上架、新歌速递
- **发现**：歌单分类浏览、排行榜、听歌记录（按日 / 本周最常听）、我的云盘
- **音乐库**：红心歌曲（按收藏月份分组）、收藏专辑、歌单
- **详情页**：专辑与歌手信息、热门歌曲、全部专辑、相似歌手与相似歌曲
- **播放**：标准 / 高音质 / 无损 / Hi-Res 四档音质（自动降级），逐行歌词与翻译
- **交互**：歌曲右键信息（发行日期、专辑、唱片公司）、评论、歌单编辑
- **语言**：简体中文、繁体中文、英文

发现页顶部栏目可在插件设置中调整顺序、名称与显示项。

## 安装

1. 需要 YesPlayMusic 3.0.0 或更高版本。进入「设置 → 插件 → 安装插件」，填入 `github.com/aliuxq/ypm-plugin-netease`
2. 确认权限后安装
3. 在左下角头像上右键，将音乐来源切换为「网易云音乐」

也可从 [Releases](https://github.com/aliuxq/ypm-plugin-netease/releases) 下载 zip，通过「从本地文件夹安装」导入。

## 登录

进入「设置 → 插件 → 网易云音乐」，在账号一栏点击登录，使用网易云音乐 App 扫码并在手机上确认。

若扫码被风控拦截：在浏览器登录 [music.163.com](https://music.163.com/)，于开发者工具的 Application → Cookies 中复制 `MUSIC_U` 的值，粘贴到插件设置的 Cookie 项后重新登录。已填写 Cookie 时优先使用。

登录状态仅保存在本机 `plugin-data/netease/` 目录，除请求网易云接口外不外发。

## 已知限制

- **不解除版权与会员限制**：无版权、需单独购买或会员专享的曲目无法播放；仅提供试听片段的曲目标记为不可播放，不以试听替代完整音轨。
- **音乐库「艺人」栏目在曲目较多时会明显卡顿**：该栏目由应用生成，会将曲库中出现的歌手渲染为大量封面气泡并逐个加载图片。插件无法移除或改写此栏目，建议避免进入。
- 部分插件能力在应用 3.0.0 中没有对应入口（个人主页、歌单重命名与删除、搜索联想），界面上不可见。
- 歌手页的专辑接口响应较慢，专辑数量较多的歌手需等待数秒。
- 网易云接口非公开接口，可能随服务端调整而失效。

## 相关

- 版本变更记录：[CHANGELOG.md](./CHANGELOG.md)
- 开发与实现说明：[DEVELOPMENT.md](./DEVELOPMENT.md)
- 问题反馈：[Issues](https://github.com/aliuxq/ypm-plugin-netease/issues)

## 声明

「网易云音乐」为网易公司商标。本项目不提供、不存储任何音乐内容，所有数据均来自使用者本人账号可访问的范围，请支持正版。

本项目基于 [lymzzyh/ypm-plugin-netease](https://github.com/lymzzyh/ypm-plugin-netease) 与 [limnea/ypm-plugin-netease](https://github.com/limnea/ypm-plugin-netease)（均为 MIT License）改编，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。以 [MIT](./LICENSE) 授权。

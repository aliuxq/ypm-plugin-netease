# NetEase Cloud Music for YesPlayMusic

[简体中文](./README.md) · English

A third-party NetEase Cloud Music source plugin for YesPlayMusic 3.0. After installing and signing in, your playlists, liked songs, saved albums, Daily Mix and Personal FM are available inside the app.

Unofficial project, not affiliated with NetEase, Inc. or the YesPlayMusic authors.

## Features

- **Home**: Daily Mix, Personal FM, charts, recommended playlists, new albums, new songs
- **Discover**: playlists by category, charts, listening history (by day / most played this week), My cloud music
- **Library**: liked songs (grouped by the month you added them), saved albums, playlists
- **Detail pages**: album and artist information, top songs, full discography, similar artists and songs
- **Playback**: Standard / High / Lossless / Hi-Res with automatic fallback; line-by-line lyrics and translations
- **Interaction**: song information from the right-click menu (release date, album, label), comments, playlist editing
- **Languages**: Simplified Chinese, Traditional Chinese, English

The tabs at the top of the Discover page can be reordered, renamed and toggled in the plugin settings.

## Installation

1. Requires YesPlayMusic 3.0.0 or later. Open **Settings → Plugins → Install plugin** and enter `github.com/aliuxq/ypm-plugin-netease`
2. Review the requested permissions and install
3. Right-click the avatar in the bottom-left corner and switch the music source to "NetEase Cloud Music"

You can also download the zip from [Releases](https://github.com/aliuxq/ypm-plugin-netease/releases) and use "Install from local folder".

## Sign in

Go to **Settings → Plugins → NetEase Cloud Music**, click Sign in in the account row, then scan the QR code with the NetEase Cloud Music app and confirm on your phone.

If QR sign-in is blocked by risk control: sign in at [music.163.com](https://music.163.com/) in a browser, open Application → Cookies in the developer tools, copy the `MUSIC_U` value, paste it into the Cookie field in the plugin settings and sign in again. A saved cookie takes priority.

The session is stored only in the local `plugin-data/netease/` directory and is sent nowhere except to NetEase's own endpoints.

## Known limitations

- **No unlocking of copyright or membership restrictions**: tracks without copyright, requiring separate purchase or exclusive to members cannot be played. Preview-only tracks are marked unplayable rather than passed off as full tracks.
- **The Library "Artists" tab becomes slow with a large library**: the app renders every artist found in your songs as cover bubbles and loads each image individually. The plugin cannot remove or change that tab; avoid opening it.
- Some plugin capabilities have no entry point in YesPlayMusic 3.0.0 (profile page, playlist rename and delete, search suggestions), so they are not reachable from the UI.
- The artist discography endpoint is slow; artists with large catalogues take a few seconds to load.
- NetEase's API is unofficial and may stop working after server-side changes.

## Links

- Changelog: [CHANGELOG.md](./CHANGELOG.md)
- Development and implementation notes: [DEVELOPMENT.md](./DEVELOPMENT.md)
- Bug reports: [Issues](https://github.com/aliuxq/ypm-plugin-netease/issues)

## Notice

"NetEase Cloud Music" is a trademark of NetEase, Inc. This project does not provide or store any music content; all data comes from what the signed-in account can access. Please support the official releases.

Based on [lymzzyh/ypm-plugin-netease](https://github.com/lymzzyh/ypm-plugin-netease) and [limnea/ypm-plugin-netease](https://github.com/limnea/ypm-plugin-netease) (both MIT), see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Licensed under [MIT](./LICENSE).

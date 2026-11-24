# NetEase Cloud Music for YesPlayMusic

[简体中文](./README.md) · English

An **unofficial** NetEase Cloud Music source plugin for [YesPlayMusic](https://github.com/qier222/YesPlayMusic) 3.0. YesPlayMusic 3.0 ships without any online music service; after installing this plugin you can sign in to your NetEase account with a QR code and keep using your playlists, liked songs, saved albums, Daily Mix and Personal FM.

> Not an official plugin. Unaffiliated with NetEase, Inc. or the YesPlayMusic authors.

## Features

- **Home**: Daily Mix and Personal FM hero cards, chart cards that list the top three tracks, recommended playlists, a new-album wall, new songs
- **Discover**: playlist square (quick categories plus a five-group "More categories" panel), charts, new albums, My cloud music
- **Search**: tracks, albums, artists, playlists, with suggestions and hot searches
- **Library**: liked songs (grouped by month by the date you added them), saved albums, playlists (with pinned "Daily Mix / Recently played / My cloud music" cards)
- **Playlists**: create, rename, delete, add/remove tracks, subscribe to others' playlists
- **Album / Artist pages**: save albums, follow artists, an artist's top songs, full discography and similar artists
- **Playback**: Standard / High / Lossless / Hi-Res quality (with automatic fallback), lyrics and translations, similar songs, Personal FM
- **Comments**: hot and latest comments, post, reply, like
- **Profile**: level, following/followers, total plays, most-played this week
- Automatically reports listening history after playback
- UI text in Simplified Chinese, Traditional Chinese and English

## Installation

1. Open YesPlayMusic (**3.0.0 or later**) → **Settings → Plugins → Install Plugin**, paste:

   ```
   github.com/aliuxq/ypm-plugin-netease
   ```

2. The app lists the plugin's permissions and capabilities before install; confirm to install.
3. Right-click the avatar at the bottom of the sidebar (or go to **Settings → Plugins → Music source**) and switch to **NetEase Cloud Music**.

Alternatively, download the zip from [Releases](https://github.com/aliuxq/ypm-plugin-netease/releases), extract it, and choose **Install from Local Folder…**.

## Sign in

Click the avatar at the bottom left → Sign in, scan the QR code with the NetEase Cloud Music app and confirm on your phone.

If QR sign-in is blocked by NetEase's risk control: sign in at [music.163.com](https://music.163.com/) in a browser, press F12 → Application → Cookies, copy the `MUSIC_U` value, and paste it into **Settings → Plugins → NetEase Cloud Music → Plugin settings** under Cookie, then click Sign in once. When set, it takes priority.

The session is stored only in the local plugin data directory (`plugin-data/netease/`) and is sent nowhere except NetEase's own servers.

## Permissions

| Permission | Purpose |
| --- | --- |
| Network: `interface.music.163.com` | The NetEase Cloud Music client API. The plugin only talks to this one host. |

The plugin does not spawn local programs and does not read or write files outside its own directory. Cover art and audio are downloaded by YesPlayMusic directly from NetEase's CDN.

## Known limitations

- **Does not unlock any content.** Songs without copyright (grayed out) and separately-purchased digital albums cannot be played; VIP songs require your account to be a VIP. Preview-only clips are marked unplayable rather than passed off as full tracks.
- The artist discography API is slow; artists with very large catalogs take a few seconds (up to 200 albums shown).
- Playlist drag-to-reorder (`movePlaylistTrack`), podcasts, and word-by-word lyrics are not implemented.
- NetEase's API is unofficial and may change or add risk-control measures at any time, which could break the plugin.

## Development

```
index.js          Plugin body: exported function names are the operations the app calls
plugin.json       Manifest: permissions, settings, sidebar navigation
client.js         eapi client: request encryption, session management
models.js         NetEase data → plugin data structures
i18n.js           host.t wrapper (supports {placeholder} interpolation)
locales/          UI translations
test/             Run the plugin in Node with a mocked host environment
```

No build step. After editing, put the files into the app's plugin directory and click **Reload** in **Settings → Plugins**.

```bash
node test/harness.mjs                       # list exported functions
node test/harness.mjs search '{"query":"海屿你"}'
node test/harness.mjs playlist '{"id":"3778678"}'
```

### Implementation notes

- Requests use the NetEase PC client's eapi protocol; encryption uses the app-provided `host.crypto` (MD5 + AES-128-ECB) with no third-party libraries and no RSA implementation needed.
- NetEase uses id `0` to mean "no such artist/album"; the plugin maps it to an empty string to avoid dead links.
- `savedAlbums` must return a plain array (the host's 3.0.0 library page treats the return value as an array directly).

## Disclaimer

- This is an unofficial third-party plugin for personal study and research, with no affiliation to NetEase, Inc. "NetEase Cloud Music" is a trademark of NetEase, Inc.
- The plugin provides and stores no music content; all data comes from what your own NetEase account can access. Please support legitimate content and comply with NetEase Cloud Music's terms of service.

## License

[MIT](./LICENSE)

# NetEase Cloud Music for YesPlayMusic

[简体中文](./README.md) · English

An **unofficial** NetEase Cloud Music source plugin for [YesPlayMusic](https://github.com/qier222/YesPlayMusic) 3.0. YesPlayMusic 3.0 ships without any online music service; after installing this plugin you can sign in to your NetEase account with a QR code and keep using your playlists, liked songs, saved albums, Daily Mix and Personal FM.

> Not an official plugin. Unaffiliated with NetEase, Inc. or the YesPlayMusic authors.

## Features

- **Home**: Daily Mix and Personal FM hero cards, chart cards that list the top three tracks, recommended playlists, a new-album wall, new songs
- **Discover**: playlist square (quick categories plus a five-group "More categories" panel), listening history (by day / most played this week), charts, new albums, My cloud music
- **Search**: tracks, albums, artists, playlists, and hot search words
- **Library**: liked songs (grouped by month by the date you added them), saved albums, playlists (with pinned "Daily Mix / Recently played / My cloud music" cards)
- **Playlists**: create, add tracks, remove tracks
- **Album / Artist pages**: save albums, follow artists, an artist's top songs, full discography and similar artists
- **Playback**: Standard / High / Lossless / Hi-Res quality (with automatic fallback), lyrics and translations, similar songs, Personal FM
- **Comments**: hot and latest comments, post, like
- **Right-click menu**: song info (release date, album, label, inferred version) and open on the NetEase website
- UI text in Simplified Chinese, Traditional Chinese and English

### Features the app gives no entry point for

These are implemented in the plugin, but YesPlayMusic 3.0.0 has no button or menu that reaches them, so they cannot be used from the UI:

| Plugin capability | Why it is not visible |
| --- | --- |
| Profile page (level, Vinyl VIP, followers, stats, top artists and tracks) | The page exists in the app, but nothing navigates to it |
| Subscribing to someone else's playlist | The app never calls that operation |
| Renaming / deleting your own playlists | Same |
| Search suggestions | The app only shows hot searches |
| Reporting listening history after playback | The app never notifies the plugin when a track finishes |

The tabs at the top of the Discover page are configurable in **Settings → Plugins → NetEase Cloud Music → Plugin settings**: pick a preset, or choose "Custom" and order/rename them with the keys `pl` / `listens` / `charts` / `new` / `cloud`. Reload the plugin afterwards.

## Installation

1. Open YesPlayMusic (**3.0.0 or later**) → **Settings → Plugins → Install Plugin**, paste:

   ```
   github.com/aliuxq/ypm-plugin-netease
   ```

2. The app lists the plugin's permissions and capabilities before install; confirm to install.
3. Right-click the avatar at the bottom of the sidebar (or go to **Settings → Plugins → Music source**) and switch to **NetEase Cloud Music**.

Alternatively, download the zip from [Releases](https://github.com/aliuxq/ypm-plugin-netease/releases), extract it, and choose **Install from Local Folder…**.

## Sign in

Go to **Settings → Plugins → NetEase Cloud Music** and click Sign in in the account row, then scan the QR code with the NetEase Cloud Music app and confirm on your phone. (Clicking the bottom-left avatar switches music sources, it is not the sign-in entry.)

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
- **Do not open the "Artists" tab of the Library when you have many songs.** It lays out every artist found in your songs as an avatar bubble (hundreds is normal) and each one downloads its own image, so the page gets noticeably slow. The tab is hard-coded in the app; the plugin cannot remove it or change how it is drawn.
- NetEase's API is unofficial and may change or add risk-control measures at any time, which could break the plugin.

### Performance

With a library of a few hundred songs and a few dozen playlists, everything except the Artists tab stays smooth:

- Home, Discover and the Charts page all return within a few hundred milliseconds.
- Switching Library tabs makes the app re-fetch the whole library (at most once per 30 s). The plugin caches liked songs, the playlist list and the cloud card for 45–60 s, which brings that step down from ~950 ms to ~56 ms.
- Playlists, albums, search, playback, lyrics and comments showed no lag.

Windows native crashes have also been observed (`0xc0000374` heap corruption / `BEX64` / `0xc0000005` in the event log). They predate this plugin's changes and are unrelated to it; include those codes when reporting upstream.

## Changelog

### v1.3.0 (2026-11-25)

- **Listening history**: a new card on Discover, grouped by day for the last 7 days, with a "most played this week" view.
- **Profile (not reachable in the app)**: level and Vinyl VIP badges, following / followers / year joined, three stat cards, and your five most-played artists this week — the app has no entry point to that page.
- **Song info (right-click)**: opens a page with release date, album and track number, label, length, aliases, and an inferred version (Live / instrumental / ...).
- **Configurable Discover tabs**: three presets, or order and rename them with `pl` / `listens` / `charts` / `new` / `cloud`.
- **Known issue**: with a large library, opening the Library "Artists" tab is slow; that tab is hard-coded in the app and cannot be removed by a plugin.

See [CHANGELOG.md](./CHANGELOG.md) for the full history.

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

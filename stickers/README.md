# Chat stickers

Drop image files here and they show up in the chat's sticker panel (the smiley button
next to the message box). No code changes needed.

## Formats

- **GIF**, **PNG** or **WebP** (`.gif`, `.png`, `.webp`); **JPEG** (`.jpg`) works too but
  has no transparency. Animated GIF and animated WebP play in the chat. Other files (and
  this README) are ignored.
- **512×512** is the recommended size (square, transparent background). Anything from
  about 256 px works; stickers are shown at about 140 px, so 2× that is plenty for sharp
  phone screens.
- **Keep files small**: under 300 KB is ideal, every sticker loads in everyone's chat.
  Files over **2 MB are skipped** (the server log says which). For animations, WebP is
  usually 3–5× smaller than GIF: `gif2webp -lossy -q 70 -mixed big.gif -o big.webp`
  (from the `webp` package), or resize the GIF to 320 px first.
- The file name becomes the sticker's name (alt text): `thumbs-up.webp` → "thumbs up".
  Stickers in a pack are sorted by file name (`01-hello.png`, `02-…` to set an order).

## Packs

- Each **folder** here is a pack. The folder name is the pack's title (`war-room/` →
  "war room"). Only one level: files in sub-sub-folders are ignored.
- **Loose files** right in `stickers/` form the default pack, "Stickers".
- Optional `pack.json` in a pack folder:

  ```json
  { "title": "War room", "order": 1, "cover": "salute.webp" }
  ```

  `title` – shown name; `order` – packs sort by it (lower first, default 0), then by title;
  `cover` – the file shown on the pack's tab (default: the first sticker).
- Names starting with `.` are ignored.

## When changes appear

The server re-reads this folder on its own a moment after files change (at the latest
within 15 s), no restart needed. Browsers that already have the chat open pick up new
stickers the next time the sticker panel is opened.

A sticker's URL includes a hash of its content, so replacing a file under the same name is
safe: everyone gets the new image. If you delete or rename a file, old messages with it
show a small "sticker" placeholder.

## Deploying

The Docker image copies this folder in at build time (`COPY stickers ./stickers`), so new
stickers go live with the next deploy. A different folder can be used with
`--stickers <dir>` or `ALLIANCE_STICKERS=<dir>` (for example one on the `/data` volume, to
change stickers without a rebuild).

## The examples

`_examples/` holds four placeholder stickers (two of them animated) so the feature can be
tried out. Delete the folder once you have your own.

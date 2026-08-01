Eris [![NPM version](https://img.shields.io/npm/v/eris.svg?style=flat-square&color=informational)](https://npmjs.com/package/eris)
====

A Node.js wrapper for interfacing with Discord.

Installing
----------

You will need Node.js 18 or newer.

```
npm install eris
```

Voice needs an Opus encoder, which is the only reason to build anything native: install `@discordjs/opus` for the fastest option, or rely on the bundled `opusscript` fallback, which is pure JavaScript. **Voice encryption itself has no native dependency** — see below.

Voice
-----

Discord removed the `xsalsa20_poly1305` encryption modes on 2024-11-18, so older releases can no longer connect to voice at all. This version speaks the current protocol:

- **Voice gateway v8**, with buffered resume (`seq_ack`), so a dropped connection replays what it missed instead of losing audio.
- **`aead_aes256_gcm_rtpsize`** and **`aead_xchacha20_poly1305_rtpsize`**, negotiated automatically, preferring AES-GCM.
- Both modes are implemented on Node's built-in `crypto`, so `tweetnacl`, `libsodium` and a C++ toolchain are no longer needed. If `sodium-native` happens to be installed it is used automatically for an allocation-free fast path.

To pin a mode instead of negotiating:

```js
bot.joinVoiceChannel(channelID, { encryptionMode: "aead_xchacha20_poly1305_rtpsize" });
```

Components V2 (lists with an image per entry)
---------------------------------------------

An embed only has one thumbnail, so a list where every entry carries its own image next to it is not something an embed can do. Discord's Components V2 can: a **container** groups everything into one block with a single accent bar down the left, and each **section** inside it gets its own image or button on the side.

```js
bot.createMessage(channelID, Eris.createListContainer({
  header: "-# Página **1** de **13**",
  title: "Noticias de anime - Crunchyroll News",
  description: "¡Aquí tienes las últimas noticias! ✨",
  color: 0xF47FFF,
  footer: "Actualizado hace un momento",
  items: [
    {
      title: "Astrae Oratio inicia inscripciones para su beta cerrada",
      url: "https://www.crunchyroll.com/news",
      description: "Ocurrirá del 19 de agosto hasta el 21 de septiembre",
      thumbnail: "https://example.com/cover.jpg",
    },
    // ...
  ],
}));
```

It returns a ready-made message payload, so it also works with `editMessage`, `createInteractionResponse` and webhooks. An item may use `text` for raw markdown instead of `title`/`description`, and `accessory` to put a button on the side instead of an image.

For layouts the helper does not cover, the primitives are exported too:

```js
const { componentsV2, container, section, separator, textDisplay, thumbnail, mediaGallery } = Eris;

bot.createMessage(channelID, componentsV2(container([
  textDisplay("## Resultado de la búsqueda"),
  separator({ spacing: 2 }),
  section(["**Mushoku Tensei**", "-# Fantasía · Isekai"], thumbnail("https://example.com/cover.jpg")),
], { color: 0xF47FFF })));
```

Discord requires the `IS_COMPONENTS_V2` flag for these messages, which the builders set for you. That flag also means the message **cannot carry `content` or `embeds`** — put the text in a `textDisplay` instead. The builders reject those combinations, along with the 40 component and 4000 character limits, so you get a clear error instead of a `400` from the API. A full example lives in [examples/componentsV2.js](examples/componentsV2.js).

Gateway compression
-------------------

`compress` accepts a transport name as well as a boolean:

```js
const bot = new Eris("Bot TOKEN", { compress: "zstd-stream" }); // Node 22.15+
```

- `"zstd-stream"` compresses best and needs no external module.
- `"zlib-stream"` (also `true`) uses `zlib-sync` when installed and otherwise falls back to Node's own zlib, so it no longer requires an optional dependency either.
- `false` disables compression.

Tests
-----

```
npm test
```

The suite covers the voice encryption modes (including the specification's own test vectors), the gateway compression paths, and a full voice handshake against a stand-in voice gateway.

Ping Pong Example
-----------------

```js
const Eris = require("eris");

// Replace TOKEN with your bot account's token
const bot = new Eris("Bot TOKEN", {
    intents: [
        "guildMessages"
    ]
});

bot.on("ready", () => { // When the bot is ready
    console.log("Ready!"); // Log "Ready!"
});

bot.on("error", (err) => {
  console.error(err); // or your preferred logger
});

bot.on("messageCreate", (msg) => { // When a message is created
    if(msg.content === "!ping") { // If the message content is "!ping"
        bot.createMessage(msg.channel.id, "Pong!");
        // Send a message in the same channel with "Pong!"
    } else if(msg.content === "!pong") { // Otherwise, if the message is "!pong"
        bot.createMessage(msg.channel.id, "Ping!");
        // Respond with "Ping!"
    }
});

bot.connect(); // Get the bot to connect to Discord
```

More examples can be found in [the examples folder](https://github.com/abalabahaha/eris/tree/master/examples).

Useful Links
------------

- [The website](https://abal.moe/Eris/) has more details and documentation.
- [The official Eris server](https://abal.moe/Eris/invite) is the best place to get support.
- [The GitHub repo](https://github.com/abalabahaha/eris) is where development primarily happens.
- [The NPM package webpage](https://npmjs.com/package/eris) is, well, the webpage for the NPM package.

License
-------

Refer to the [LICENSE](LICENSE) file.

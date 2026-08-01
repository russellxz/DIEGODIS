"use strict";

const Eris = require("eris");

// Replace TOKEN with your bot account's token
const bot = new Eris("Bot TOKEN", {
  intents: [
    "guildMessages",
    "messageContent",
  ],
});

bot.on("ready", () => {
  console.log("Ready!");
});

bot.on("error", (err) => {
  console.error(err);
});

const NEWS = [
  {
    title: "Astrae Oratio inicia inscripciones para su beta cerrada",
    url: "https://www.crunchyroll.com/news",
    description: "Ocurrirá del 19 de agosto hasta el 21 de septiembre",
    thumbnail: "https://cdn.discordapp.com/embed/avatars/0.png",
  },
  {
    title: "The Iceblade Sorcerer Shall Rule the World estrena teaser trailer de su temporada 2",
    url: "https://www.crunchyroll.com/news",
    description: "El anime de fantasía regresa en octubre",
    thumbnail: "https://cdn.discordapp.com/embed/avatars/1.png",
  },
  {
    title: "ANÁLISIS – Rhythm Heaven Groove",
    url: "https://www.crunchyroll.com/news",
    description: "La mejor entrega de esta fabulosa saga de videojuegos rítmicos",
    thumbnail: "https://cdn.discordapp.com/embed/avatars/2.png",
  },
];

bot.on("messageCreate", (msg) => {
  if (msg.content === "!noticias") {
    // One container holding every entry, so the block gets a single accent bar
    // down its left edge instead of one per entry, and each entry keeps its own
    // image beside it. An embed cannot do this: it only has one thumbnail.
    bot.createMessage(msg.channel.id, Eris.createListContainer({
      header: "-# Página **1** de **13**",
      title: "Noticias de anime - Crunchyroll News",
      description: "¡Aquí tienes las últimas noticias! ✨",
      color: 0xF47FFF,
      items: NEWS,
      footer: "Actualizado hace un momento",
    }));
  } else if (msg.content === "!manual") {
    // The same thing assembled by hand, for layouts the helper does not cover
    const { componentsV2, container, section, separator, textDisplay, thumbnail } = Eris;

    bot.createMessage(msg.channel.id, componentsV2(container([
      textDisplay("## Resultado de la búsqueda"),
      separator({ spacing: 2 }),
      section(
        ["**Mushoku Tensei: Jobless Reincarnation**", "-# Fantasía · Isekai · 2021"],
        thumbnail("https://cdn.discordapp.com/embed/avatars/3.png", { description: "Portada" }),
      ),
      separator(),
      // A section's accessory can be a button instead of an image
      section("**Ver en Crunchyroll**", {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: Eris.Constants.ButtonStyles.LINK,
        label: "Abrir",
        url: "https://www.crunchyroll.com",
      }),
    ], { color: 0xF47FFF })));
  }
});

bot.connect();

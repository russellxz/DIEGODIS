"use strict";

const {
  componentsV2,
  container,
  countComponents,
  createListContainer,
  mediaGallery,
  section,
  separator,
  textDisplay,
  thumbnail,
} = require("../lib/util/Components");
const { ComponentTypes, MessageFlags } = require("../lib/Constants");
const { Suite } = require("./harness");

module.exports = async function run() {
  const suite = new Suite("Components V2 builders");
  suite.start();

  // --- Primitives ---
  suite.check("textDisplay carries its markdown",
    JSON.stringify(textDisplay("**hi**")) === JSON.stringify({ type: 10, content: "**hi**" }));

  const thumb = thumbnail("https://example.com/a.png", { description: "alt", spoiler: true });
  suite.check("thumbnail wraps the url as unfurled media",
    thumb.type === ComponentTypes.THUMBNAIL && thumb.media.url === "https://example.com/a.png"
    && thumb.description === "alt" && thumb.spoiler === true);
  suite.check("thumbnail accepts attachment references",
    thumbnail("attachment://cover.png").media.url === "attachment://cover.png");

  const sec = section(["one", "two"], thumb);
  suite.check("section holds its text displays and accessory",
    sec.type === ComponentTypes.SECTION && sec.components.length === 2
    && sec.components.every((c) => c.type === ComponentTypes.TEXT_DISPLAY)
    && sec.accessory === thumb);

  const sep = separator({ spacing: 2, divider: false });
  suite.check("separator honours divider and spacing",
    sep.type === ComponentTypes.SEPARATOR && sep.divider === false && sep.spacing === 2);
  suite.check("separator draws a divider by default", separator().divider === true);

  const gallery = mediaGallery(["https://example.com/1.png", { media: "https://example.com/2.png", description: "two" }]);
  suite.check("mediaGallery normalizes both shapes",
    gallery.items.length === 2 && gallery.items[0].media.url === "https://example.com/1.png"
    && gallery.items[1].description === "two");

  const box = container([textDisplay("hi")], { color: 0xF47FFF });
  suite.check("container carries the accent color as accent_color",
    box.type === ComponentTypes.CONTAINER && box.accent_color === 0xF47FFF);

  // --- Payload assembly ---
  const payload = componentsV2(box);
  suite.check("componentsV2 sets the IS_COMPONENTS_V2 flag",
    (payload.flags & MessageFlags.IS_COMPONENTS_V2) === MessageFlags.IS_COMPONENTS_V2);
  suite.check("componentsV2 preserves existing flags",
    (componentsV2(box, { flags: MessageFlags.EPHEMERAL }).flags & MessageFlags.EPHEMERAL) === MessageFlags.EPHEMERAL);
  suite.check("componentsV2 keeps other message options",
    componentsV2(box, { messageReference: { messageID: "1" } }).messageReference.messageID === "1");

  // --- Validation ---
  const rejects = (name, fn) => {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    suite.check(name, threw);
  };
  rejects("rejects content alongside components", () => componentsV2(box, { content: "hi" }));
  rejects("rejects embeds alongside components", () => componentsV2(box, { embeds: [{ title: "x" }] }));
  rejects("rejects an empty text display", () => textDisplay(""));
  rejects("rejects a section with four text displays", () => section(["a", "b", "c", "d"], thumb));
  rejects("rejects an empty section", () => section([], thumb));
  rejects("rejects an empty container", () => container([]));
  rejects("rejects media without a url", () => thumbnail({ href: "https://example.com" }));
  rejects("rejects an item with no text at all", () => createListContainer({ items: [{ thumbnail: "https://x/1.png" }] }));
  rejects("rejects more than 40 components", () => {
    const many = [];
    for (let i = 0; i < 45; i++) {
      many.push(textDisplay(`line ${i}`));
    }
    return componentsV2(container(many));
  });
  rejects("rejects more than 4000 characters of text", () =>
    componentsV2(container([textDisplay("x".repeat(4001))])));

  suite.check("countComponents walks nested components and accessories",
    countComponents([container([section("a", thumbnail("https://x/1.png")), separator()])]) === 5,
    `${countComponents([container([section("a", thumbnail("https://x/1.png")), separator()])])}`);

  // --- The list layout ---
  const list = createListContainer({
    header: "-# Página **1** de **13**",
    title: "Noticias de anime",
    description: "¡Aquí tienes las últimas noticias!",
    color: 0xF47FFF,
    footer: "Fuente: Crunchyroll",
    items: [
      { title: "Primera", url: "https://example.com/1", description: "Una", thumbnail: "https://example.com/1.png" },
      { title: "Segunda", description: "Dos", thumbnail: "https://example.com/2.png" },
      { text: "Texto crudo sin imagen" },
    ],
  });

  suite.check("the whole list is a single container", list.components.length === 1
    && list.components[0].type === ComponentTypes.CONTAINER);
  suite.check("the list sets the Components V2 flag",
    (list.flags & MessageFlags.IS_COMPONENTS_V2) === MessageFlags.IS_COMPONENTS_V2);

  const children = list.components[0].components;
  const sections = children.filter((c) => c.type === ComponentTypes.SECTION);
  const separators = children.filter((c) => c.type === ComponentTypes.SEPARATOR);

  suite.check("each item with an image becomes a section", sections.length === 2, `${sections.length}/2`);
  suite.check("every section gets its own thumbnail on the side",
    sections.every((s) => s.accessory && s.accessory.type === ComponentTypes.THUMBNAIL));
  suite.check("entries are divided by separators", separators.length === 4 && separators.every((s) => s.divider),
    `${separators.length} separators`);
  suite.check("a title with a url becomes a bold masked link",
    sections[0].components[0].content === "**[Primera](https://example.com/1)**\nUna",
    JSON.stringify(sections[0].components[0].content));
  suite.check("a title without a url stays bold text",
    sections[1].components[0].content === "**Segunda**\nDos");
  suite.check("an item without an image stays a plain text display",
    children.some((c) => c.type === ComponentTypes.TEXT_DISPLAY && c.content === "Texto crudo sin imagen"));
  suite.check("the heading is rendered as a markdown heading",
    children[1].content === "## Noticias de anime");
  suite.check("the footer is rendered as subtext",
    children[children.length - 1].content === "-# Fuente: Crunchyroll");

  suite.check("dividers can be turned off",
    createListContainer({
      dividers: false,
      title: "T",
      items: [{ title: "a", thumbnail: "https://x/1.png" }],
    }).components[0].components.every((c) => c.type !== ComponentTypes.SEPARATOR || c.divider === false));

  suite.check("a custom accessory replaces the thumbnail", (() => {
    const button = { type: ComponentTypes.BUTTON, style: 5, label: "Ver", url: "https://example.com" };
    const built = createListContainer({ items: [{ title: "a", accessory: button }] });
    const entry = built.components[0].components[0];
    return entry.type === ComponentTypes.SECTION && entry.accessory === button;
  })());

  suite.check("extra components are appended inside the container", (() => {
    const row = { type: ComponentTypes.ACTION_ROW, components: [] };
    const built = createListContainer({ items: [{ title: "a" }], components: [row] });
    const inner = built.components[0].components;
    return inner[inner.length - 1] === row;
  })());

  suite.check("an empty item list still produces a valid container",
    createListContainer({ title: "Sin resultados", items: [] }).components[0].components.length === 1);

  return suite;
};

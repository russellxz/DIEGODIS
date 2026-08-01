"use strict";

const { ComponentTypes, MessageFlags, SeparatorSpacingSizes } = require("../Constants");

/**
 * Discord counts every component in a message, nesting included
 */
const MAX_COMPONENTS = 40;
/**
 * Combined limit across every text display in a message
 */
const MAX_TEXT_LENGTH = 4000;
/**
 * A section holds its text in one to three text displays
 */
const MAX_SECTION_TEXT = 3;

/**
 * Wrap a media reference in the object shape the API expects
 * @arg {Object | String} media A URL, an `attachment://` reference, or a media object
 * @returns {Object} The unresolved media object
 */
function toMedia(media) {
  if (typeof media === "string") {
    return { url: media };
  }
  if (media && typeof media === "object" && typeof media.url === "string") {
    return media;
  }
  throw new TypeError("Media must be a URL string or an object with a url property");
}

/**
 * Count a component and everything nested inside it
 * @arg {Object | Array<Object>} component The component(s) to count
 * @returns {Number} The total number of components
 */
function countComponents(component) {
  if (Array.isArray(component)) {
    return component.reduce((total, child) => total + countComponents(child), 0);
  }
  if (!component || typeof component !== "object") {
    return 0;
  }
  let total = 1;
  if (Array.isArray(component.components)) {
    total += countComponents(component.components);
  }
  if (component.accessory) {
    total += countComponents(component.accessory);
  }
  return total;
}

/**
 * Add up the text carried by every text display in a component tree
 * @arg {Object | Array<Object>} component The component(s) to measure
 * @returns {Number} The total number of characters
 */
function textLength(component) {
  if (Array.isArray(component)) {
    return component.reduce((total, child) => total + textLength(child), 0);
  }
  if (!component || typeof component !== "object") {
    return 0;
  }
  let total = component.type === ComponentTypes.TEXT_DISPLAY && component.content ? component.content.length : 0;
  if (Array.isArray(component.components)) {
    total += textLength(component.components);
  }
  if (component.accessory) {
    total += textLength(component.accessory);
  }
  return total;
}

/**
 * Create a text display component, the Components V2 equivalent of message content
 * @arg {String} content The markdown text to show
 * @returns {Object} A text display component
 */
function textDisplay(content) {
  if (typeof content !== "string" || content.length === 0) {
    throw new TypeError("A text display needs non-empty content");
  }
  return { type: ComponentTypes.TEXT_DISPLAY, content: content };
}

/**
 * Create a thumbnail, the small image shown to the right of a section
 * @arg {Object | String} media The image URL, or an `attachment://` reference
 * @arg {Object} [options] Thumbnail options
 * @arg {String} [options.description] Alt text for the image
 * @arg {Boolean} [options.spoiler] Whether to hide the image behind a spoiler
 * @returns {Object} A thumbnail component
 */
function thumbnail(media, options = {}) {
  const component = { type: ComponentTypes.THUMBNAIL, media: toMedia(media) };
  if (options.description !== undefined) {
    component.description = options.description;
  }
  if (options.spoiler !== undefined) {
    component.spoiler = !!options.spoiler;
  }
  return component;
}

/**
 * Create a section: up to three lines of text with an image or button beside them
 * @arg {String | Array<String | Object>} content The text, either markdown or ready-made text displays
 * @arg {Object} [accessory] The component shown to the side, usually a thumbnail or a button
 * @returns {Object} A section component
 */
function section(content, accessory) {
  const children = (Array.isArray(content) ? content : [content])
    .map((child) => typeof child === "string" ? textDisplay(child) : child);

  if (children.length === 0 || children.length > MAX_SECTION_TEXT) {
    throw new RangeError(`A section needs between 1 and ${MAX_SECTION_TEXT} text displays, got ${children.length}`);
  }

  const component = { type: ComponentTypes.SECTION, components: children };
  if (accessory) {
    component.accessory = accessory;
  }
  return component;
}

/**
 * Create a separator, the horizontal rule used to divide entries
 * @arg {Object} [options] Separator options
 * @arg {Boolean} [options.divider=true] Whether to draw a visible line, rather than blank space
 * @arg {Number} [options.spacing=1] The padding around it, `1` for small and `2` for large
 * @returns {Object} A separator component
 */
function separator(options = {}) {
  return {
    type: ComponentTypes.SEPARATOR,
    divider: options.divider === undefined ? true : !!options.divider,
    spacing: options.spacing || SeparatorSpacingSizes.SMALL,
  };
}

/**
 * Create a media gallery, a grid of up to ten images
 * @arg {Array<Object | String>} items The images, either URLs or objects with `media`, `description` and `spoiler`
 * @returns {Object} A media gallery component
 */
function mediaGallery(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError("A media gallery needs at least one item");
  }
  return {
    type: ComponentTypes.MEDIA_GALLERY,
    items: items.map((item) => {
      if (typeof item === "string") {
        return { media: toMedia(item) };
      }
      const entry = { media: toMedia(item.media || item.url) };
      if (item.description !== undefined) {
        entry.description = item.description;
      }
      if (item.spoiler !== undefined) {
        entry.spoiler = !!item.spoiler;
      }
      return entry;
    }),
  };
}

/**
 * Create a container: the bordered block with a colored bar down its left edge.
 * Everything inside renders as a single unit, which is what makes a list of
 * entries look like one embed instead of several
 * @arg {Array<Object>} components The components to place inside
 * @arg {Object} [options] Container options
 * @arg {Number} [options.color] The accent color of the left bar
 * @arg {Boolean} [options.spoiler] Whether to hide the container behind a spoiler
 * @returns {Object} A container component
 */
function container(components, options = {}) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new TypeError("A container needs at least one component");
  }
  const component = { type: ComponentTypes.CONTAINER, components: components };
  const color = options.color !== undefined ? options.color : options.accentColor;
  if (color !== undefined && color !== null) {
    component.accent_color = color;
  }
  if (options.spoiler !== undefined) {
    component.spoiler = !!options.spoiler;
  }
  return component;
}

/**
 * Turn components into a message payload, setting the flag that switches the
 * message over to Components V2
 * @arg {Object | Array<Object>} components The top-level component(s)
 * @arg {Object} [options] Extra message options to merge in, such as `messageReference`
 * @returns {Object} A payload for createMessage, editMessage or an interaction response
 */
function componentsV2(components, options = {}) {
  const list = Array.isArray(components) ? components : [components];

  const total = countComponents(list);
  if (total > MAX_COMPONENTS) {
    throw new RangeError(`A message can hold at most ${MAX_COMPONENTS} components, this one has ${total}`);
  }
  const length = textLength(list);
  if (length > MAX_TEXT_LENGTH) {
    throw new RangeError(`Text displays can hold at most ${MAX_TEXT_LENGTH} characters in total, this message has ${length}`);
  }
  if (options.content) {
    throw new TypeError("A Components V2 message cannot carry content, put the text in a text display instead");
  }
  if (options.embed || options.embeds) {
    throw new TypeError("A Components V2 message cannot carry embeds, use a container instead");
  }

  return Object.assign({}, options, {
    components: list,
    flags: (options.flags || 0) | MessageFlags.IS_COMPONENTS_V2,
  });
}

/**
 * Build a list of entries inside a single container, each with its own title,
 * description and image to the side, divided by separators.
 *
 * This is the layout that reads as one tall embed: because it is a single
 * container, there is one accent bar down the whole block rather than one per
 * entry, and unlike an embed each entry can carry its own image
 * @arg {Object} options List options
 * @arg {Array<Object>} options.items The entries to list
 * @arg {String} [options.items[].title] The entry title, shown in bold
 * @arg {String} [options.items[].url] Makes the title a link
 * @arg {String} [options.items[].description] The text under the title
 * @arg {String} [options.items[].text] Raw markdown for the entry, used instead of title/description
 * @arg {String} [options.items[].thumbnail] The image shown to the right of the entry
 * @arg {String} [options.items[].imageDescription] Alt text for that image
 * @arg {Object} [options.items[].accessory] A component to show instead of the thumbnail, such as a button
 * @arg {Number} [options.color] The accent color of the container's left bar
 * @arg {String} [options.header] A line above the title, for things like page counters
 * @arg {String} [options.title] The heading of the block
 * @arg {String} [options.description] A line under the heading
 * @arg {String} [options.footer] A line below the entries, rendered as small text
 * @arg {Boolean} [options.dividers=true] Whether to draw a line between entries
 * @arg {Array<Object>} [options.components] Extra components appended inside the container, such as an action row
 * @arg {Boolean} [options.spoiler] Whether to hide the container behind a spoiler
 * @returns {Object} A payload for createMessage, editMessage or an interaction response
 */
function createListContainer(options = {}) {
  const items = options.items || [];
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }

  const children = [];
  if (options.header) {
    children.push(textDisplay(options.header));
  }
  if (options.title) {
    children.push(textDisplay(`## ${options.title}`));
  }
  if (options.description) {
    children.push(textDisplay(options.description));
  }

  const hasHeading = children.length > 0;
  items.forEach((item, i) => {
    if (hasHeading || i > 0) {
      children.push(separator({ divider: options.dividers !== false }));
    }

    let text = item.text;
    if (text === undefined) {
      const title = item.url ? `**[${item.title}](${item.url})**` : `**${item.title}**`;
      text = item.title ? title : "";
      if (item.description) {
        text += text ? `\n${item.description}` : item.description;
      }
    }
    if (!text) {
      throw new TypeError(`Item ${i} needs a title, a description or text`);
    }

    const accessory = item.accessory
      || (item.thumbnail ? thumbnail(item.thumbnail, { description: item.imageDescription }) : null);

    // A section is only valid with an accessory, so plain entries stay text
    children.push(accessory ? section(text, accessory) : textDisplay(text));
  });

  if (options.footer) {
    children.push(separator({ divider: options.dividers !== false }));
    children.push(textDisplay(`-# ${options.footer}`));
  }
  if (options.components) {
    children.push(...options.components);
  }

  return componentsV2(container(children, { color: options.color, spoiler: options.spoiler }));
}

module.exports = {
  componentsV2,
  container,
  countComponents,
  createListContainer,
  mediaGallery,
  section,
  separator,
  textDisplay,
  thumbnail,
};

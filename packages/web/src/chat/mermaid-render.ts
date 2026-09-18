import { renderMermaidSVG } from "beautiful-mermaid";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ELEMENTS = new Set([
  "svg",
  "defs",
  "marker",
  "g",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "tspan",
  "title",
  "desc",
]);
const CLASSES = new Set([
  "mono",
  "node",
  "edge",
  "edge-label",
  "subgraph",
  "class-node",
  "entity",
  "actor",
  "lifeline",
  "activation",
  "message",
  "er-relationship",
  "xychart-grid",
  "xychart-bar",
  "xychart-line",
  "xychart-line-shadow",
  "xychart-dot",
  "xychart-label",
  "xychart-axis-title",
  "xychart-title",
  "xychart-legend-line",
]);
const THEME_COLORS = ["bg", "fg", "line", "accent", "muted", "surface", "border"] as const;
const DERIVED_COLORS = [
  "--_text",
  "--_text-sec",
  "--_text-muted",
  "--_text-faint",
  "--_line",
  "--_arrow",
  "--_node-fill",
  "--_node-stroke",
  "--_group-fill",
  "--_group-hdr",
  "--_inner-stroke",
  "--_key-badge",
];
const PAINT = new Set(["fill", "stroke", "color", "background-color"]);
const PRESENTATION = new Set([
  ...PAINT,
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "fill-rule",
  "fill-opacity",
  "stroke-opacity",
  "opacity",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "letter-spacing",
  "word-spacing",
]);
const LENGTHS = new Set([
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "dx",
  "dy",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
]);
const MARKERS = new Set(["marker-start", "marker-mid", "marker-end"]);
const COLOR_FUNCTIONS = new Set([
  "var",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
]);
const ID = /^[A-Za-z_][A-Za-z0-9_.:-]*$/u;
const SERIES_CLASS = /^xychart-color-(?:0|[1-9][0-9]*)$/u;
const NUMBERS = /^[0-9eE+.,\s-]+$/u;
const LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|em|%)?$/iu;
let renderNamespaceCounter = 0;

export interface MermaidRenderTheme {
  readonly bg: string;
  readonly fg: string;
  readonly line: string;
  readonly accent: string;
  readonly muted: string;
  readonly surface: string;
  readonly border: string;
  readonly fontSans: string;
  readonly fontMono: string;
}

interface StyleRule {
  readonly target: string | SVGElement;
  readonly specificity: number;
  readonly declarations: CSSStyleDeclaration;
}

export function renderMermaidDiagram(source: string, theme: MermaidRenderTheme): SVGSVGElement {
  const colors = {
    bg: hexColor(theme.bg),
    fg: hexColor(theme.fg),
    line: hexColor(theme.line),
    accent: hexColor(theme.accent),
    muted: hexColor(theme.muted),
    surface: hexColor(theme.surface),
    border: hexColor(theme.border),
  };
  const rawSvg = renderMermaidSVG(source, { ...colors, font: "Inter", transparent: true });
  const parsed = new DOMParser().parseFromString(rawSvg, "image/svg+xml");
  const root = parsed.documentElement;
  if (parsed.doctype || parsed.querySelector("parsererror") || root.localName !== "svg") {
    throw new Error("Renderer output is not a valid SVG document.");
  }

  const originals = [root, ...root.querySelectorAll("*")];
  const ids = new Map<string, string>();
  const markerIds = new Map<string, string>();
  const classes = new Set(CLASSES);
  const variables = new Set([...THEME_COLORS.map((name) => `--${name}`), ...DERIVED_COLORS]);
  const prefix = `mermaid-${++renderNamespaceCounter}-`;
  for (const node of originals) {
    if (
      node.namespaceURI !== SVG_NAMESPACE ||
      (!ELEMENTS.has(node.localName) && node.localName !== "style")
    ) {
      throw new Error(`Unsupported SVG element ${node.localName}.`);
    }
    if (node.localName === "style") continue;
    const id = node.getAttribute("id");
    if (id !== null) {
      if (!ID.test(id) || ids.has(id)) throw new Error("Invalid or duplicate SVG identifier.");
      ids.set(id, `${prefix}${id}`);
      if (node.localName === "marker") markerIds.set(id, `${prefix}${id}`);
    }
    for (const name of node.classList) {
      if (!SERIES_CLASS.test(name)) continue;
      classes.add(name);
      const index = name.slice("xychart-color-".length);
      variables.add(`--xychart-color-${index}`);
      variables.add(`--xychart-bar-fill-${index}`);
    }
  }

  const safeRoot = document.createElementNS(SVG_NAMESPACE, "svg");
  const nodes = new Map<Element, SVGElement>([[root, safeRoot]]);
  for (const original of originals) {
    if (original.localName === "style") continue;
    let node = nodes.get(original);
    if (!node) {
      node = document.createElementNS(SVG_NAMESPACE, original.localName);
      nodes.set(original, node);
    }
    for (const attribute of original.attributes) {
      copyAttribute(node, attribute, ids, markerIds, classes, variables);
    }
    for (const child of original.childNodes) {
      if (child instanceof Element) {
        if (child.localName === "style") continue;
        const safeChild = document.createElementNS(SVG_NAMESPACE, child.localName);
        nodes.set(child, safeChild);
        node.append(safeChild);
      } else if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
        node.append(document.createTextNode(child.textContent ?? ""));
      }
    }
  }

  for (const name of variables) safeRoot.style.setProperty(name, "initial");
  applyStyles(originals, nodes, classes, variables);
  for (const name of THEME_COLORS) safeRoot.style.setProperty(`--${name}`, colors[name]);
  safeRoot.style.setProperty("color", colors.fg);
  safeRoot.style.setProperty("font-family", theme.fontSans);
  for (const node of nodes.values()) {
    if (node.localName === "text" || node.classList.contains("mono")) {
      node.style.setProperty(
        "font-family",
        node.classList.contains("mono") ? theme.fontMono : theme.fontSans,
      );
    }
  }
  safeRoot.setAttribute("class", "chat-mermaid-svg");
  safeRoot.setAttribute("role", "img");
  safeRoot.setAttribute("aria-label", "Mermaid diagram");
  safeRoot.setAttribute("focusable", "false");
  return safeRoot;
}

function hexColor(value: string): string {
  const color = value.trim();
  if (/^#[0-9a-f]{6}$/iu.test(color)) return color;
  if (/^#[0-9a-f]{3}$/iu.test(color))
    return `#${color.slice(1).replace(/./gu, (digit) => digit + digit)}`;
  throw new Error("Mermaid theme colors must be hex colors.");
}

function safeColor(value: string, variables: ReadonlySet<string>): boolean {
  if (!/^[a-z0-9_#%.,()+/\s-]+$/iu.test(value) || value.includes("/*")) return false;
  if (/\b(?:inherit|initial|unset|revert|revert-layer)\b/iu.test(value)) return false;
  for (const match of value.matchAll(/([a-z_-][a-z0-9_-]*)\s*\(/giu)) {
    const name = match[1];
    if (!name || !COLOR_FUNCTIONS.has(name.toLowerCase())) return false;
  }
  for (const match of value.matchAll(/--[a-z0-9_-]+/giu)) {
    if (!variables.has(match[0])) return false;
  }
  return CSS.supports("color", value);
}

function safeDeclaration(name: string, value: string, variables: ReadonlySet<string>): boolean {
  if (variables.has(name)) return safeColor(value, variables);
  if (!PRESENTATION.has(name)) return false;
  if (PAINT.has(name))
    return (
      (name !== "color" && name !== "background-color" && value === "none") ||
      safeColor(value, variables)
    );
  return /^[a-z0-9%.,\s+-]+$/iu.test(value) && CSS.supports(name, value);
}

function selectorSpecificity(selector: string, classes: ReadonlySet<string>): number | null {
  if (!/^(?:[a-z]+)?(?:\.[a-z][a-z0-9-]*)*$/u.test(selector) || !selector) return null;
  const [tag, ...names] = selector.split(".");
  if ((tag && !ELEMENTS.has(tag)) || names.some((name) => !classes.has(name))) return null;
  return names.length * 100 + (tag ? 1 : 0);
}

function applyStyles(
  originals: readonly Element[],
  nodes: ReadonlyMap<Element, SVGElement>,
  classes: ReadonlySet<string>,
  variables: ReadonlySet<string>,
): void {
  const rules: StyleRule[] = [];
  for (const original of originals) {
    if (original.localName !== "style") continue;
    const css = original.textContent ?? "";
    if (css.includes("\\")) throw new Error("Escaped SVG styles are not supported.");
    // Constructed sheets are never attached. replaceSync discards upstream font imports.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    for (const rule of sheet.cssRules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      for (const part of rule.selectorText.split(",")) {
        const selector = part.trim();
        const specificity = selectorSpecificity(selector, classes);
        if (specificity !== null)
          rules.push({ target: selector, specificity, declarations: rule.style });
      }
    }
  }
  for (const [original, node] of nodes) {
    const inline = original.getAttribute("style");
    if (!inline) continue;
    if (inline.includes("\\")) throw new Error("Escaped SVG styles are not supported.");
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("svg {}");
    const rule = sheet.cssRules[0];
    if (rule instanceof CSSStyleRule) {
      rule.style.cssText = inline;
      rules.push({ target: node, specificity: Infinity, declarations: rule.style });
    }
  }
  rules.sort((a, b) => a.specificity - b.specificity);
  for (const important of [false, true]) {
    for (const rule of rules) {
      const declarations: [string, string][] = [];
      for (const name of rule.declarations) {
        if ((rule.declarations.getPropertyPriority(name) === "important") !== important) continue;
        const value = rule.declarations.getPropertyValue(name).trim();
        if (safeDeclaration(name, value, variables)) declarations.push([name, value]);
      }
      if (!declarations.length) continue;
      for (const node of nodes.values()) {
        if (typeof rule.target === "string" ? !node.matches(rule.target) : node !== rule.target)
          continue;
        for (const [name, value] of declarations) node.style.setProperty(name, value);
      }
    }
  }
}

function copyAttribute(
  node: SVGElement,
  attribute: Attr,
  ids: ReadonlyMap<string, string>,
  markerIds: ReadonlyMap<string, string>,
  classes: ReadonlySet<string>,
  variables: ReadonlySet<string>,
): void {
  const { name, value } = attribute;
  if (name === "xmlns" || name === "style" || name === "font-family") return;
  if (attribute.namespaceURI !== null || name.startsWith("on") || name === "href") {
    throw new Error(`Unsupported SVG attribute ${name}.`);
  }
  if (name === "id") {
    const id = ids.get(value);
    if (id) node.setAttribute(name, id);
    return;
  }
  if (name === "class") {
    node.setAttribute(
      name,
      value
        .split(/\s+/u)
        .filter((item) => classes.has(item))
        .join(" "),
    );
    return;
  }
  if (MARKERS.has(name)) {
    if (value === "none") {
      node.setAttribute(name, value);
      return;
    }
    const match = /^url\(#([A-Za-z_][A-Za-z0-9_.:-]*)\)$/u.exec(value);
    const id = match?.[1] ? markerIds.get(match[1]) : undefined;
    if (!id) throw new Error("SVG markers must reference an internal marker.");
    node.setAttribute(name, `url(#${id})`);
    return;
  }
  if (PRESENTATION.has(name)) {
    const cssValue =
      name === "font-size" && /^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(value) ? `${value}px` : value;
    if (!safeDeclaration(name, cssValue, variables))
      throw new Error(`Unsafe SVG presentation value for ${name}.`);
    node.setAttribute(name, value);
    return;
  }
  if (LENGTHS.has(name)) {
    if (!LENGTH.test(value)) throw new Error(`Invalid SVG length for ${name}.`);
  } else if (name === "viewBox" || name === "points") {
    if (!NUMBERS.test(value)) throw new Error(`Invalid SVG coordinates for ${name}.`);
  } else if (name === "d") {
    if (!/^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\s-]*$/u.test(value)) throw new Error("Invalid SVG path.");
  } else if (name === "transform") {
    if (!/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9eE+.,\s-]+\)\s*)+$/u.test(value)) {
      throw new Error("Invalid SVG transform.");
    }
  } else if (name === "orient") {
    if (value !== "auto" && value !== "auto-start-reverse" && !LENGTH.test(value))
      throw new Error("Invalid marker orientation.");
  } else if (name === "markerUnits") {
    if (value !== "strokeWidth" && value !== "userSpaceOnUse")
      throw new Error("Invalid marker units.");
  } else if (name === "preserveAspectRatio") {
    if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?: (?:meet|slice))?$/u.test(value))
      throw new Error("Invalid SVG aspect ratio.");
  } else {
    return;
  }
  node.setAttribute(name, value);
}

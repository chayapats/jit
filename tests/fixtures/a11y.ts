/**
 * Deterministic accessibility checks of server-rendered HTML (UX03, NFR-11). No browser: a strict tree builder for
 * the generated markup and the WCAG rules the markup can break on its own — language, title, zoom, one main landmark
 * reached by the skip link first, one h1, unique and resolvable id references, names for every link, button and
 * form control, decorative or labelled SVG, no positive tabindex, no focusable aria-hidden content, no nested
 * interactive content, lists, fieldset legends, and distinct names for dialogs and nav/aside landmarks. Contrast is covered by ui.design_tokens/v1 tests.
 */
interface Node { tag: string; attrs: Record<string, string>; children: (Node | string)[]; parent: Node | null }
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "path", "circle", "rect"]);
/** A strict tree builder for the generated markup: unbalanced or mismatched tags fail the check. */
function parseHtml(html: string): Node {
  const root: Node = { tag: "#root", attrs: {}, children: [], parent: null };
  let current = root;
  const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const source = html.replace(/<!doctype html>/i, "");
  for (const match of source.matchAll(/<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (match[5] !== undefined) { if (match[5].trim()) current.children.push(unescape(match[5])); continue; }
    if (match[1]) {
      const tag = match[1].toLowerCase();
      if (current.tag !== tag) throw new Error(`mismatched </${tag}> inside <${current.tag}>`);
      current = current.parent!;
      continue;
    }
    const tag = match[2]!.toLowerCase(), attrs: Record<string, string> = {};
    for (const a of match[3]!.matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) {
      if (a[1]! in attrs) throw new Error(`duplicate attribute ${a[1]} on <${tag}>`);
      attrs[a[1]!.toLowerCase()] = unescape(a[2] ?? "");
    }
    const node: Node = { tag, attrs, children: [], parent: current };
    current.children.push(node);
    if (!voidTags.has(tag) && !match[4]) current = node;
  }
  if (current !== root) throw new Error(`unclosed <${current.tag}>`);
  return root;
}
const elements = (node: Node): Node[] => node.children.flatMap(child => typeof child === "string" ? [] : [child, ...elements(child)]);
/** Content the accessibility tree leaves out: `aria-hidden="true"` and the `hidden` attribute. */
const hiddenFromAt = (node: Node) => node.attrs["aria-hidden"] === "true" || "hidden" in node.attrs;
/** True when the node or any ancestor is hidden from assistive technology. */
/** The `hidden` attribute on the node or an ancestor: not rendered, so not focusable. */
const hiddenFromAtAttr = (node: Node | null): boolean => !!node && ("hidden" in node.attrs || hiddenFromAtAttr(node.parent));
const hiddenInTree = (node: Node | null): boolean => !!node && (hiddenFromAt(node) || hiddenInTree(node.parent));
/** Accessible name per the parts of accname that the markup uses: aria-labelledby, aria-label, content, title. */
function accessibleName(node: Node, byId: Map<string, Node>): string {
  // Referenced labels count even when hidden themselves (accname 2B), but their own hidden parts do not.
  // With at least one valid IDREF, aria-labelledby decides alone, even when the result is empty.
  const refs = idrefs(node.attrs["aria-labelledby"]).filter(id => byId.has(id));
  if (refs.length) return refs.map(id => text(byId.get(id)!)).join(" ").trim();
  if (node.attrs["aria-label"]?.trim()) return node.attrs["aria-label"].trim();
  const content = text(node);
  return content || (node.attrs.title ?? "").trim();
}
/**
 * Name of a form control in accname order, with no fallback past a step that applies: aria-labelledby with at least
 * one valid IDREF decides alone (an empty result is no name), then aria-label, then the native labels associated with
 * it (`label[for]` naming its id, or a `label` without `for` whose first labelable descendant it is) that are exposed. A native label's text leaves out its hidden parts and the
 * control's own content, such as a wrapped select's options.
 */
function controlName(node: Node, all: Node[], byId: Map<string, Node>): string {
  const refs = idrefs(node.attrs["aria-labelledby"]).filter(id => byId.has(id));
  if (refs.length) return refs.map(id => text(byId.get(id)!)).join(" ").trim();
  if (node.attrs["aria-label"]?.trim()) return node.attrs["aria-label"].trim();
  // HTML label association: `for` names the control's id; a label without `for` labels its first labelable descendant.
  const labels = all.filter(n => n.tag === "label" && (n.attrs.for !== undefined
    ? Boolean(node.attrs.id) && n.attrs.for === node.attrs.id
    : elements(n).find(labelable) === node));
  return labels.filter(label => !hiddenInTree(label)).map(label => text(label, node)).join(" ").trim();
}
/** IDREF list tokens: whitespace-separated, never empty. */
const idrefs = (value: string | undefined) => (value ?? "").split(/\s+/).filter(Boolean);
/** Landmarks and dialogs are named only by aria-labelledby or aria-label, never by their content. */
const landmarkName = (node: Node, byId: Map<string, Node>) => idrefs(node.attrs["aria-labelledby"]).length || node.attrs["aria-label"]?.trim() ? accessibleName(node, byId) : "";
/** Exposed text of a subtree: hidden parts and the `skip` subtree are left out; a labelled SVG contributes its label. */
function text(node: Node, skip?: Node): string {
  return node.children.map(child => typeof child === "string" ? child : hiddenFromAt(child) || child === skip ? ""
    : child.tag === "svg" ? child.attrs.role === "img" ? child.attrs["aria-label"] ?? "" : "" : text(child, skip)).join(" ").replace(/\s+/g, " ").trim();
}
/** Labelable elements (HTML): what a `label` can be associated with. */
const labelable = (node: Node) => ["button", "select", "textarea", "meter", "output", "progress"].includes(node.tag) || (node.tag === "input" && node.attrs.type !== "hidden");
/** Interactive content (HTML content model): what may not be nested in a link or button. */
const interactive = (node: Node) => ["button", "select", "textarea", "summary"].includes(node.tag)
  || (node.tag === "a" && "href" in node.attrs) || (node.tag === "input" && node.attrs.type !== "hidden");
const focusable = (node: Node) => node.attrs.tabindex !== "-1" && (interactive(node) || node.attrs.tabindex !== undefined);

/** Deterministic WCAG checks of one served document; returns readable problems. */
export function accessibilityProblems(html: string, locale: "th" | "en"): string[] {
  const problems: string[] = [];
  let root: Node;
  try { root = parseHtml(html); } catch (error) { return [`markup: ${(error as Error).message}`]; }
  const all = elements(root), byId = new Map<string, Node>();
  const where = (node: Node) => `<${node.tag}${node.attrs.id ? `#${node.attrs.id}` : ""}${node.attrs.class ? `.${node.attrs.class.split(" ")[0]}` : ""}${node.attrs.href ? ` href=${node.attrs.href}` : ""}>`;
  for (const node of all) {
    if (node.attrs.id === undefined) continue;
    // An empty or spaced id can never be referenced; it is reported and left out of the lookup.
    if (!/^\S+$/.test(node.attrs.id)) { problems.push(`${where(node)} invalid id "${node.attrs.id}"`); continue; }
    if (byId.has(node.attrs.id)) problems.push(`duplicate id ${node.attrs.id}`);
    byId.set(node.attrs.id, node);
  }
  const html0 = all.find(n => n.tag === "html")!;
  if (html0.attrs.lang !== locale) problems.push(`html lang ${html0.attrs.lang} (expected ${locale})`);
  if (!text(all.find(n => n.tag === "title")!)) problems.push("empty title");
  const viewport = all.find(n => n.tag === "meta" && n.attrs.name === "viewport")?.attrs.content ?? "";
  if (!/width=device-width/.test(viewport) || /user-scalable=no|maximum-scale/.test(viewport)) problems.push(`viewport ${viewport}`);
  const mains = all.filter(n => n.tag === "main");
  if (mains.length !== 1 || mains[0]!.attrs.id !== "main-content") problems.push(`main landmarks ${mains.length}`);
  const firstFocusable = all.find(n => n.parent && focusable(n) && !n.attrs.hidden);
  if (firstFocusable?.attrs.href !== "#main-content") problems.push(`first focusable is ${firstFocusable ? where(firstFocusable) : "none"}, not the skip link`);
  // Several landmarks of one kind are told apart by their names.
  for (const kind of ["nav", "aside"]) {
    const names = all.filter(n => n.tag === kind).map(n => landmarkName(n, byId));
    if (new Set(names).size !== names.length) problems.push(`${kind} landmarks share a name: ${names.join(" | ")}`);
  }
  const h1 = all.filter(n => n.tag === "h1");
  if (h1.length !== 1) problems.push(`${h1.length} h1 headings`);
  for (const node of all) {
    const { tag, attrs } = node;
    for (const ref of ["for", "aria-controls", "aria-labelledby", "aria-describedby"]) {
      for (const id of idrefs(attrs[ref])) if (!byId.has(id)) problems.push(`${where(node)} ${ref}=${id} points nowhere`);
    }
    if (tag === "a" && attrs.href?.startsWith("#") && attrs.href.length > 1 && !byId.has(attrs.href.slice(1))) problems.push(`${where(node)} targets a missing id`);
    if (attrs.tabindex !== undefined && Number(attrs.tabindex) > 0) problems.push(`${where(node)} positive tabindex`);
    if (/^h[1-6]$/.test(tag) && !text(node)) problems.push(`${where(node)} empty heading`);
    if (tag === "img" && attrs.alt === undefined) problems.push(`${where(node)} without alt`);
    if (tag === "svg" && attrs["aria-hidden"] !== "true" && !(attrs.role === "img" && attrs["aria-label"]?.trim())) {
      let inner = node.parent; let hidden = false;
      while (inner) { if (hiddenFromAt(inner)) hidden = true; inner = inner.parent; }
      if (!hidden) problems.push(`${where(node)} svg is neither decorative nor labelled`);
    }
    if (tag === "li" && !["ul", "ol"].includes(node.parent!.tag)) problems.push(`${where(node)} li outside a list`);
    if (tag === "fieldset" && !node.children.some(child => typeof child !== "string" && child.tag === "legend")) problems.push(`${where(node)} fieldset without legend`);
    if ((tag === "dialog" || tag === "nav" || tag === "aside") && !landmarkName(node, byId)) problems.push(`${where(node)} ${tag} without a name`);
    // Inside an aria-hidden subtree a control can still take focus; only the `hidden` attribute removes it.
    const ariaHidden = (n: Node | null): boolean => !!n && (n.attrs["aria-hidden"] === "true" || ariaHidden(n.parent));
    if (focusable(node) && ariaHidden(node) && !hiddenFromAtAttr(node)) problems.push(`${where(node)} aria-hidden but focusable`);
    if ((tag === "button" || (tag === "a" && "href" in attrs)) && elements(node).some(interactive)) problems.push(`${where(node)} nests interactive content`);
    const named = (tag === "a" && "href" in attrs) || tag === "button" || tag === "summary";
    if (named && !hiddenInTree(node) && !accessibleName(node, byId)) problems.push(`${where(node)} has no accessible name`);
    if (tag === "input" && ["submit", "reset", "button"].includes(attrs.type ?? "") && !hiddenInTree(node)
      && !(attrs["aria-labelledby"] ? accessibleName(node, byId) : attrs["aria-label"]?.trim() || (attrs.value === undefined ? attrs.type !== "button" : attrs.value.trim()))) {
      problems.push(`${where(node)} has no accessible name`);
    }
    if (["input", "select", "textarea"].includes(tag) && !["hidden", "submit", "reset", "button"].includes(attrs.type ?? "") && !hiddenInTree(node)
      && !(attrs.type === "image" && attrs.alt?.trim()) && !controlName(node, all, byId)) problems.push(`${where(node)}[name=${attrs.name}] has no label`);
  }
  return problems;
}

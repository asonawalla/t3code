import { LRUCache } from "./lruCache";

const images = new LRUCache<string>(64, 8 * 1024 * 1024);
let renderQueue = Promise.resolve();
let nextDiagramId = 0;

/** Mermaid has global configuration, so each theme change must finish rendering before the next. */
export function renderMermaidImage(code: string, theme: "light" | "dark"): Promise<string> {
  const key = `${theme}\0${code}`;
  const cached = images.get(key);
  if (cached !== null) return Promise.resolve(cached);

  const result = renderQueue.then(async () => {
    // Another mounted copy may have queued the same diagram before it was cached.
    const cached = images.get(key);
    if (cached !== null) return cached;

    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      fontFamily: "Arial, sans-serif",
      flowchart: { wrappingWidth: 320 },
      theme: theme === "dark" ? "dark" : "default",
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
      ],
    });
    const container = document.createElement("div");
    container.setAttribute("aria-hidden", "true");
    // Keep text measurable without exposing Mermaid's temporary rendering DOM.
    container.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none";
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`t3-mermaid-${++nextDiagramId}`, code, container);
      const element = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      const [, , width = 0, height = 0] =
        element
          .getAttribute("viewBox")
          ?.trim()
          .split(/[\s,]+/)
          .map(Number) ?? [];
      let source = svg;
      if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        // Percentage dimensions have a 300x150 default viewport when loaded as an image.
        element.setAttribute("width", String(width));
        element.setAttribute("height", String(height));
        source = new XMLSerializer().serializeToString(element);
      }
      const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
      images.set(key, image, (key.length + image.length) * 2);
      return image;
    } finally {
      container.remove();
    }
  });
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

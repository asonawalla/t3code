// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vite-plus/test";

const { mermaid } = vi.hoisted(() => ({
  mermaid: { initialize: vi.fn(), render: vi.fn() },
}));

vi.mock("mermaid", () => ({ default: mermaid }));

let renderMermaidImage: typeof import("./mermaid").renderMermaidImage;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  ({ renderMermaidImage } = await import("./mermaid"));
});

it("serializes theme changes and reuses completed images for concurrent copies and remounts", async () => {
  const started = deferred<void>();
  const firstRender = deferred<{ svg: string }>();
  let currentTheme: string | undefined;
  const renderedThemes: Array<string | undefined> = [];
  mermaid.initialize.mockImplementation((config: { theme: string }) => {
    currentTheme = config.theme;
  });
  mermaid.render.mockImplementation(async () => {
    renderedThemes.push(currentTheme);
    if (renderedThemes.length === 1) {
      started.resolve();
      return firstRender.promise;
    }
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg">Light</svg>' };
  });

  const dark = renderMermaidImage("graph TD; A-->B", "dark");
  const duplicate = renderMermaidImage("graph TD; A-->B", "dark");
  const light = renderMermaidImage("graph TD; A-->B", "light");
  await started.promise;
  expect(renderedThemes).toEqual(["dark"]);
  expect(currentTheme).toBe("dark");

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="4 4 360 1110.8"><text>Résumé #1</text></svg>';
  firstRender.resolve({ svg });
  const [darkImage, duplicateImage, lightImage] = await Promise.all([dark, duplicate, light]);

  const imageSvg = new DOMParser().parseFromString(
    decodeURIComponent(darkImage.split(",")[1]!),
    "image/svg+xml",
  ).documentElement;
  expect(imageSvg.getAttribute("width")).toBe("360");
  expect(imageSvg.getAttribute("height")).toBe("1110.8");
  expect(imageSvg.textContent).toBe("Résumé #1");
  expect(darkImage.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  expect(duplicateImage).toBe(darkImage);
  expect(lightImage).not.toBe(darkImage);
  expect(renderedThemes).toEqual(["dark", "default"]);
  expect(await renderMermaidImage("graph TD; A-->B", "dark")).toBe(darkImage);
  expect(mermaid.render).toHaveBeenCalledTimes(2);
  expect(document.body.childElementCount).toBe(0);
  expect(mermaid.initialize).toHaveBeenCalledWith(
    expect.objectContaining({
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
      htmlLabels: false,
      secure: expect.arrayContaining(["securityLevel", "htmlLabels", "suppressErrorRendering"]),
    }),
  );
});

it("removes temporary DOM after errors and allows both queued diagrams and retries", async () => {
  const containers: Element[] = [];
  mermaid.render.mockImplementation(async (_id: string, _code: string, container: Element) => {
    containers.push(container);
    expect(container.isConnected).toBe(true);
    container.innerHTML = "<svg><text>Temporary diagram</text></svg>";
    if (containers.length === 1) throw new Error("Invalid diagram");
    return { svg: "<svg>Recovered</svg>" };
  });

  const failed = renderMermaidImage("broken", "dark");
  const queued = renderMermaidImage("graph TD; C-->D", "light");
  await expect(failed).rejects.toThrow("Invalid diagram");
  await expect(queued).resolves.toContain("data:image/svg+xml");
  await expect(renderMermaidImage("broken", "dark")).resolves.toContain("data:image/svg+xml");

  expect(mermaid.render).toHaveBeenCalledTimes(3);
  expect(containers.every((container) => !container.isConnected)).toBe(true);
  expect(document.body.childElementCount).toBe(0);
});

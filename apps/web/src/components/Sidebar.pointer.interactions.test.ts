// @vitest-environment jsdom
import type { SensorProps } from "@dnd-kit/core";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { SidebarPointerSensor } from "./Sidebar.pointer";

const sensors: SidebarPointerSensor[] = [];

afterEach(() => {
  for (const sensor of sensors.splice(0)) sensor.cancel();
  document.body.replaceChildren();
});

it.each([
  ["Archive button", "<button>Archive</button>", "button", false],
  ["Archive label", "<button><span>Archive</span></button>", "span", false],
  ["Archive icon", "<button><svg><path /></svg></button>", "path", false],
  ["pull request link", '<a href="#"><span>PR</span></a>', "span", false],
  ["rename input", "<input />", "input", false],
  ["editable text", "<div contenteditable><span>Title</span></div>", "span", false],
  ["row title", "<span>Title</span>", "span", true],
] as const)(
  "preserves the %s gesture after moving past the drag threshold",
  (_, html, selector, drags) => {
    const row = document.createElement("div");
    row.setAttribute("role", "button");
    row.innerHTML = html;
    document.body.append(row);
    const target = row.querySelector(selector)!;
    const clicked = vi.fn();
    const onStart = vi.fn();
    target.addEventListener("click", clicked);
    row.addEventListener("pointerdown", (nativeEvent) => {
      const accepted = SidebarPointerSensor.activators[0]!.handler({
        nativeEvent,
      } as ReactPointerEvent);
      if (!accepted) return;
      sensors.push(
        new SidebarPointerSensor({
          active: "thread",
          event: nativeEvent,
          options: { distance: 6, onAttach: vi.fn(), onFinish: vi.fn() },
          onStart,
          onMove: vi.fn(),
          onEnd: vi.fn(),
          onCancel: vi.fn(),
          onAbort: vi.fn(),
          onPending: vi.fn(),
        } as unknown as SensorProps<
          ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]
        >),
      );
    });

    const pointer = { pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10 };
    target.dispatchEvent(
      new PointerEvent("pointerdown", { ...pointer, bubbles: true, buttons: 1 }),
    );
    target.dispatchEvent(
      new PointerEvent("pointermove", { ...pointer, bubbles: true, buttons: 1, clientY: 17 }),
    );
    target.dispatchEvent(
      new PointerEvent("pointerup", { ...pointer, bubbles: true, buttons: 0, clientY: 17 }),
    );
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onStart).toHaveBeenCalledTimes(drags ? 1 : 0);
    expect(clicked).toHaveBeenCalledTimes(drags ? 0 : 1);
  },
);

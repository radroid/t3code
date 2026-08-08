import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AutoResumeOverlay, SegmentedToggle } from "./AutoResumeOverlay";

const noop = () => {};

const renderToggle = (enabled: boolean) =>
  renderToStaticMarkup(<SegmentedToggle enabled={enabled} onChange={noop} />);

describe("SegmentedToggle", () => {
  it("names the group for screen readers — a tooltip is not an accessible name", () => {
    const html = renderToggle(true);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Auto-resume"');
  });

  it("exposes both options as radios", () => {
    const html = renderToggle(true);
    expect(html).toContain(">Off<");
    expect(html).toContain(">On<");
    expect(html.match(/role="radio"/g)).toHaveLength(2);
  });

  it("checks On and leaves Off unchecked when enabled", () => {
    const html = renderToggle(true);
    // Off is rendered first, so the first aria-checked belongs to it.
    const checkedFlags = [...html.matchAll(/aria-checked="(true|false)"/g)].map((m) => m[1]);
    expect(checkedFlags).toEqual(["false", "true"]);
  });

  it("checks Off and leaves On unchecked when disabled", () => {
    const html = renderToggle(false);
    const checkedFlags = [...html.matchAll(/aria-checked="(true|false)"/g)].map((m) => m[1]);
    expect(checkedFlags).toEqual(["true", "false"]);
  });

  it("keeps the pair to a single tab stop via roving tabindex", () => {
    const enabledHtml = renderToggle(true);
    expect([...enabledHtml.matchAll(/tabindex="(-?\d)"/g)].map((m) => m[1])).toEqual(["-1", "0"]);

    const disabledHtml = renderToggle(false);
    expect([...disabledHtml.matchAll(/tabindex="(-?\d)"/g)].map((m) => m[1])).toEqual(["0", "-1"]);
  });

  it("slides the thumb rather than cross-fading two backgrounds", () => {
    expect(renderToggle(true)).toContain("translate-x-full");
    expect(renderToggle(false)).toContain("translate-x-0");
  });

  it("respects prefers-reduced-motion on every animated element", () => {
    const html = renderToggle(true);
    // The thumb transition and the label colour transition must both opt out.
    expect(html.match(/motion-reduce:transition-none/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("AutoResumeOverlay", () => {
  it("renders nothing until the server confirms the feature is reachable", () => {
    // No state has loaded (effects do not run during static rendering), so the overlay must be
    // invisible rather than flashing an empty control over the thread.
    const html = renderToStaticMarkup(
      <AutoResumeOverlay threadRef={{ environmentId: "env-1", threadId: "thread-a" }} />,
    );
    expect(html).toBe("");
  });
});

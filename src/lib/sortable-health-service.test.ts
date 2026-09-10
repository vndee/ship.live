import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SortableHealthService } from "../components/SortableHealthService.tsx";

function renderHandle(disabled: boolean, unavailable: boolean) {
  const markup = renderToStaticMarkup(
    createElement(SortableHealthService, {
      id: "payments",
      name: "Payments",
      expanded: false,
      disabled,
      unavailable,
      children: (handle) => handle,
    }),
  );
  const button = markup.match(/<button\b[^>]*>/)?.[0];
  assert.ok(button, "the real sortable wrapper renders its activator");
  return button;
}

test("pending service saves keep the disabled activator natively focusable", () => {
  const button = renderHandle(true, false);
  assert.doesNotMatch(button, /\sdisabled(?:=|\s|>)/);
  assert.match(button, /tabindex="0"/);
  assert.match(button, /aria-disabled="true"/);
});

test("a service that cannot be reordered has a natively disabled handle", () => {
  const button = renderHandle(false, true);
  assert.match(button, /\sdisabled=""/);
  assert.match(button, /aria-disabled="true"/);
});

test("an available idle service handle remains enabled", () => {
  const button = renderHandle(false, false);
  assert.doesNotMatch(button, /\sdisabled(?:=|\s|>)/);
  assert.match(button, /aria-disabled="false"/);
});

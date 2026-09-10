import { useMemo, useSyncExternalStore } from "react";
import { parseRoute, routeHref, type Route } from "../lib/routes";

const NAVIGATED = "ship-live:navigate";

function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener(NAVIGATED, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(NAVIGATED, callback);
  };
}
const location = () => window.location.pathname + window.location.search;

export interface NavigateOptions {
  /** Update the current history entry, as for filters and search text. */
  replace?: boolean;
  /** An overlay such as a profile: Back closes it instead of leaving the page. */
  overlay?: boolean;
}

export function navigate(route: Route, options: NavigateOptions = {}) {
  const href = routeHref(route);
  if (href === location()) return;
  const state = options.overlay ? { overlay: true } : null;
  const previous = parseRoute(window.location.pathname, window.location.search);
  if (options.replace) window.history.replaceState(state, "", href);
  else window.history.pushState(state, "", href);
  if (!options.replace && previous.page !== route.page) window.scrollTo(0, 0);
  window.dispatchEvent(new Event(NAVIGATED));
}

/** Closes an overlay the app opened with Back, or removes one opened by a link. */
export function closeOverlay(route: Route) {
  if ((window.history.state as { overlay?: boolean } | null)?.overlay)
    window.history.back();
  else navigate(route, { replace: true });
}

export function useRoute(): Route {
  const current = useSyncExternalStore(subscribe, location);
  return useMemo(() => {
    const url = new URL(current, window.location.origin);
    return parseRoute(url.pathname, url.search);
  }, [current]);
}

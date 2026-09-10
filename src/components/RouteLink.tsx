import type { AnchorHTMLAttributes } from "react";
import { navigate } from "../hooks/useRoute";
import { routeHref, type Route } from "../lib/routes";

/** A real link, so pages open in a new tab too; plain clicks stay in the app. */
export function RouteLink({
  to,
  onClick,
  ...props
}: { to: Route } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a
      {...props}
      href={routeHref(to)}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(to);
      }}
    />
  );
}

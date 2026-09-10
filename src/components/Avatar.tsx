import { useState } from "react";

/** A GitHub avatar, or initials when there is none or it fails to load. */
export function Avatar({ name, url }: { name: string; url?: string }) {
  const [failed, setFailed] = useState(false);
  const initials = name.includes(" ")
    ? name
        .split(" ")
        .map((part) => part[0])
        .slice(0, 2)
        .join("")
    : name.slice(0, 2);
  return (
    <span className="avatar" aria-label={name}>
      {url?.startsWith("https://avatars.githubusercontent.com/") && !failed ? (
        <img src={url} alt="" onError={() => setFailed(true)} />
      ) : (
        initials.toUpperCase()
      )}
    </span>
  );
}

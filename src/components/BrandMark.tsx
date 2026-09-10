/**
 * The Orbit Pulse mark beside the wordmark. Dark grounds use the transparent
 * mark; light grounds use the app icon, which carries its own dark tile,
 * because the brand never recolors the mark's individual paths.
 */
export function BrandMark() {
  return (
    <>
      <img
        className="brand-mark brand-mark-dark"
        src="/branding/orbit-pulse-mark.svg"
        alt=""
        width={30}
        height={30}
      />
      <img
        className="brand-mark brand-mark-light"
        src="/favicon.svg"
        alt=""
        width={30}
        height={30}
      />
    </>
  );
}

// URLs the app reads from. Every one is absolute http(s), checked once, here.

declare const urlBrand: unique symbol;
export type Url = string & { readonly [urlBrand]: true };

/** Parses `text`, resolved against `base` when it is relative. Throws unless it is http(s). */
export function parseUrl(text: string, base?: string): Url {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw new Error(`not a URL: ${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http and https URLs can be read: ${text}`);
  }
  return url.href as Url;
}

/** The file name a URL ends in, e.g. `building.parquet`. */
export function fileName(url: Url): string {
  return new URL(url).pathname.split("/").at(-1) ?? "";
}

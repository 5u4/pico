import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import * as Schema from "effect/Schema";
import type { BrowserOperation } from "./browser-extension.ts";

const Expiry = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(-1));
const ExportCookie = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[^\p{Cc}\s;=]*$/u)),
  value: Schema.String.check(Schema.isPattern(/^[^\p{Cc};]*$/u)),
  domain: Schema.NonEmptyString,
  path: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\/[^\p{Cc};]*$/u))),
  secure: Schema.optionalKey(Schema.Boolean),
  httpOnly: Schema.optionalKey(Schema.Boolean),
  hostOnly: Schema.optionalKey(Schema.Boolean),
  expires: Schema.optionalKey(Expiry),
  expirationDate: Schema.optionalKey(Expiry),
  session: Schema.optionalKey(Schema.Boolean),
  sameSite: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^(strict|lax|none|no_restriction|unspecified)$/i)),
  ),
  partitionKey: Schema.optionalKey(Schema.Null),
  partitionKeyOpaque: Schema.optionalKey(Schema.Literal(false)),
  partitioned: Schema.optionalKey(Schema.Literal(false)),
  firstPartyDomain: Schema.optionalKey(Schema.Literal("")),
});
const Cookies = Schema.Array(ExportCookie).check(Schema.isMinLength(1));
const decodeExport = Schema.decodeUnknownSync(
  Schema.Union([Cookies, Schema.Struct({ cookies: Cookies })]),
);
type Cookie = Pick<typeof ExportCookie.Type, "name" | "value"> & {
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expires?: number;
  readonly sameSite?: "Strict" | "Lax" | "None";
};
type CookieImport = Extract<BrowserOperation, { op: "import_cookies" }>;
type CookieFileSource =
  | Omit<Extract<CookieImport, { format: "header" }>, "op" | "userApproved">
  | Omit<Exclude<CookieImport, { format: "header" }>, "op" | "userApproved">;

export const readCookieFile = async (
  source: CookieFileSource,
  signal?: AbortSignal,
): Promise<Cookie[]> => {
  if (source.format !== undefined && source.format !== "json" && source.format !== "header")
    throw new Error("Cookie import format must be json or header.");
  let target: URL | null = null;
  if (source.format === "header") {
    target = typeof source.url === "string" ? URL.parse(source.url) : null;
    if (
      !target ||
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      !target.hostname ||
      target.hostname.startsWith(".") ||
      target.username ||
      target.password ||
      /[\p{Cc}]/u.test(source.url)
    )
      throw new Error("Cookie header import requires an HTTP(S) URL without credentials.");
  } else if ("url" in source) {
    throw new Error("Cookie import target URL requires header format.");
  }
  let contents: string;
  try {
    contents = await readFile(source.path, { encoding: "utf8", signal });
  } catch {
    throw new Error("Cookie file could not be read.");
  }
  try {
    let input: unknown;
    if (target) {
      let header = contents.trim();
      if (/[\p{Cc}\u2028\u2029]/u.test(header)) throw new Error();
      if (/^cookie:/i.test(header)) header = header.slice("Cookie:".length).trim();
      if (!header) throw new Error();
      const pairs = header.split(";");
      if (pairs.at(-1)?.trim() === "") pairs.pop();
      const names = new Set<string>();
      const { hostname, protocol } = target;
      input = pairs.map((pair) => {
        const equals = pair.indexOf("=");
        if (equals < 0) throw new Error();
        const name = pair.slice(0, equals).trim();
        if (!name || name.includes(":") || names.has(name)) throw new Error();
        names.add(name);
        return {
          name,
          value: pair.slice(equals + 1).trim(),
          domain: hostname,
          hostOnly: true,
          path: "/",
          secure: protocol === "https:",
          httpOnly: name.startsWith("__Http-") || name.startsWith("__Host-Http-"),
          session: true,
        };
      });
    } else {
      input = JSON.parse(contents);
    }
    const decoded = decodeExport(input);
    const cookies = "cookies" in decoded ? decoded.cookies : decoded;
    return cookies.map((cookie): Cookie => {
      const hostOnly = cookie.hostOnly ?? !cookie.domain.startsWith(".");
      const host = cookie.domain.replace(/^\./, "").toLowerCase();
      const domain = domainToASCII(host);
      const ip = isIP(
        domain.startsWith("[") && domain.endsWith("]") ? domain.slice(1, -1) : domain,
      );
      if (
        (!hostOnly && ip) ||
        (!ip &&
          (!domain ||
            domain.length > 253 ||
            !domain
              .split(".")
              .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) ||
        /[\s/@:#?\\]/.test(host.replace(/^\[[0-9a-f:]+\]$/, ""))
      )
        throw new Error();
      if (
        cookie.expires !== undefined &&
        cookie.expirationDate !== undefined &&
        cookie.expires !== cookie.expirationDate
      )
        throw new Error();
      const expiry = cookie.expires ?? cookie.expirationDate;
      if (cookie.session === false && (expiry === undefined || expiry < 0)) throw new Error();
      if (expiry !== undefined && expiry < 0 && expiry !== -1) throw new Error();
      const expires = cookie.session === true || expiry === -1 ? undefined : expiry;
      let sameSite: Cookie["sameSite"];
      switch (cookie.sameSite?.toLowerCase()) {
        case "strict":
          sameSite = "Strict";
          break;
        case "lax":
          sameSite = "Lax";
          break;
        case "none":
        case "no_restriction":
          sameSite = "None";
          break;
      }
      if (sameSite === "None" && cookie.secure !== true) throw new Error();
      if (
        (cookie.name.startsWith("__Secure-") && cookie.secure !== true) ||
        ((cookie.name.startsWith("__Http-") || cookie.name.startsWith("__Host-Http-")) &&
          (cookie.secure !== true || cookie.httpOnly !== true)) ||
        (cookie.name.startsWith("__Host-") &&
          (cookie.secure !== true || !hostOnly || (cookie.path ?? "/") !== "/"))
      )
        throw new Error();
      return {
        name: cookie.name,
        value: cookie.value,
        domain: hostOnly ? domain : `.${domain}`,
        path: cookie.path ?? "/",
        secure: cookie.secure ?? false,
        httpOnly: cookie.httpOnly ?? false,
        ...(expires === undefined ? {} : { expires }),
        ...(sameSite === undefined ? {} : { sameSite }),
      };
    });
  } catch {
    throw new Error(
      source.format === "header"
        ? "Cookie file must contain one valid Cookie header with unique names."
        : "Cookie file must contain a nonempty JSON cookie array with supported metadata.",
    );
  }
};

import { describe, expect, it } from "vitest";
import { cookieHeaderForSite, parseCookieEditorExport } from "../src/ui/cookie-import.js";

describe("Cookie-Editor import", () => {
  it("reads JSON, Header String and Netscape exports", () => {
    expect(parseCookieEditorExport(JSON.stringify([
      { domain: ".example.com", name: "session", value: "json", path: "/" },
    ]))).toMatchObject([{ domain: "example.com", name: "session", value: "json" }]);
    expect(parseCookieEditorExport("Cookie: session=header; theme=dark"))
      .toMatchObject([{ name: "session", value: "header" }, { name: "theme", value: "dark" }]);
    expect(parseCookieEditorExport([
      "# Netscape HTTP Cookie File",
      ".example.com\tTRUE\t/\tTRUE\t1893456000\tsession\tnetscape",
    ].join("\n"))).toMatchObject([{
      domain: "example.com", hostOnly: false, secure: true, name: "session", value: "netscape",
    }]);
  });

  it("scopes cookies by domain, hostOnly, path, protocol and expiry", () => {
    const rows = parseCookieEditorExport(JSON.stringify([
      { domain: ".example.com", name: "session", value: "parent", path: "/" },
      { domain: "api.example.com", hostOnly: true, name: "session", value: "exact", path: "/api" },
      { domain: "example.com", hostOnly: true, name: "host-only", value: "wrong", path: "/" },
      { domain: ".example.com", name: "console", value: "wrong", path: "/console" },
      { domain: ".example.com", name: "expired", value: "wrong", expirationDate: 1 },
      { domain: ".example.com", name: "secure", value: "yes", secure: true },
    ]));
    expect(cookieHeaderForSite(rows, "api.example.com", {
      protocol: "https:", requestPaths: ["/api/user/self"], now: 2_000,
    })).toBe("session=exact; secure=yes");
    expect(cookieHeaderForSite(rows, "api.example.com", {
      protocol: "http:", requestPaths: ["/api/user/self"], now: 2_000,
    })).toBe("session=exact");
  });

  it("rejects malformed or unsafe exports", () => {
    expect(() => parseCookieEditorExport("{bad json"))
      .toThrow("Cookie-Editor JSON is malformed");
    expect(() => parseCookieEditorExport("bad-name; still-bad"))
      .toThrow("does not contain usable cookies");
    expect(() => parseCookieEditorExport("Cookie: session=ok\r\nX-Test: injected"))
      .toThrow("must be on one line");
  });
});

jest.mock("dns/promises", () => ({ Resolver: jest.fn() }));
jest.mock("https", () => ({ __esModule: true, default: { request: jest.fn() } }));

import { EventEmitter } from "events";
import { Resolver } from "dns/promises";
import https from "https";
import { integrationHttpJson, isIntegrationHttpRetryableError } from "../../src/modules/integrations-core/application/integration-http-client";
import { isPublicIntegrationAddress, validateIntegrationUrl } from "../../src/modules/integrations-core/application/integration-destination";

const previousPolicy = process.env.INTEGRATION_HTTP_ALLOWED_ORIGINS_PARTNER;
let resolver: any;
let requests: any[];
let respond: (req: any) => void;
let handshake: boolean;

function response(req: any, statusCode = 200, chunks = [Buffer.from('{"ok":true}')], headers: Record<string, string> = {}) {
  const incoming: any = new EventEmitter();
  incoming.statusCode = statusCode; incoming.headers = headers; incoming.destroy = jest.fn();
  req.incoming = incoming; req.emit("response", incoming);
  chunks.forEach((chunk) => incoming.emit("data", chunk)); incoming.emit("end");
}

beforeEach(() => {
  process.env.INTEGRATION_HTTP_ALLOWED_ORIGINS_PARTNER = "https://partner.example.test";
  resolver = { resolve4: jest.fn(async () => ["8.8.8.8"]), resolve6: jest.fn(async () => ["2001:4860:4860::8888"]), cancel: jest.fn() };
  (Resolver as jest.Mock).mockImplementation(() => resolver);
  requests = []; handshake = true; respond = (req) => response(req);
  (https.request as jest.Mock).mockReset().mockImplementation((options) => {
    const req: any = new EventEmitter(); req.options = options; req.closed = false;
    req.destroy = jest.fn(() => { req.closed = true; queueMicrotask(() => req.emit("close")); });
    req.end = jest.fn(() => queueMicrotask(() => {
      const socket: any = new EventEmitter();
      socket.destroy = jest.fn(() => queueMicrotask(() => socket.emit("close")));
      req.socket = socket; req.emit("socket", socket); if (handshake) socket.emit("secureConnect"); respond(req);
    }));
    requests.push(req); return req;
  });
});
afterEach(() => jest.useRealTimers());
afterAll(() => { if (previousPolicy === undefined) delete process.env.INTEGRATION_HTTP_ALLOWED_ORIGINS_PARTNER; else process.env.INTEGRATION_HTTP_ALLOWED_ORIGINS_PARTNER = previousPolicy; });
const call = (overrides: any = {}) => integrationHttpJson({ providerCode: "partner", url: "https://partner.example.test/api", method: "POST", timeoutMs: 1000, body: { shipment: "test" }, ...overrides });

it.each(["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.1.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:8.8.8.8", "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "fe80::1%eth0"])("rejects private/reserved/mapped destination %s", (address) => {
  expect(isPublicIntegrationAddress(address)).toBe(false);
});
it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111"])("recognizes public address %s", (address) => expect(isPublicIntegrationAddress(address)).toBe(true));

it.each(["file:///etc/passwd", "http://partner.example.test", "https://user:pass@partner.example.test", "https://partner.example.test:8443", "https://partner.example.test.evil.test", "https://localhost", "https://2130706433", "https://0x7f000001", "https://[::ffff:127.0.0.1]", "https://partner.example.test/#secret", "https://partner.example.test."])("rejects URL policy violations before DNS/network: %s", async (url) => {
  await expect(call({ url })).rejects.toMatchObject({ code: "EDESTINATION" });
  expect(resolver.resolve4).not.toHaveBeenCalled(); expect(https.request).not.toHaveBeenCalled();
});

it("fails closed when the per-provider server allowlist is absent", async () => {
  delete process.env.INTEGRATION_HTTP_ALLOWED_ORIGINS_PARTNER;
  await expect(call()).rejects.toMatchObject({ code: "EDESTINATION" }); expect(https.request).not.toHaveBeenCalled();
});

it.each([["private", ["127.0.0.1"]], ["mixed", ["8.8.8.8", "10.0.0.1"]]])("rejects unsafe %s A answers without connecting", async (_label, answers) => {
  resolver.resolve4.mockResolvedValue(answers); await expect(call()).rejects.toMatchObject({ code: "EDESTINATION" }); expect(https.request).not.toHaveBeenCalled();
});
it("rejects a private AAAA answer even alongside a public A record", async () => {
  resolver.resolve6.mockResolvedValue(["::ffff:169.254.169.254"]);
  await expect(call()).rejects.toMatchObject({ code: "EDESTINATION" }); expect(https.request).not.toHaveBeenCalled();
});

it("pins the actual request IP and verifies the original TLS hostname", async () => {
  await expect(call()).resolves.toMatchObject({ statusCode: 200, body: { ok: true } });
  const options = requests[0].options;
  expect(options).toMatchObject({ hostname: "8.8.8.8", family: 4, port: 443, servername: "partner.example.test", rejectUnauthorized: true, agent: false, headers: { host: "partner.example.test" } });
  expect(options.checkServerIdentity("8.8.8.8", { subjectaltname: "DNS:partner.example.test" })).toBeUndefined();
  expect(options.checkServerIdentity("8.8.8.8", { subjectaltname: "DNS:other.example.test" })).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  expect(resolver.resolve4).toHaveBeenCalledTimes(1); expect(resolver.cancel).toHaveBeenCalled(); expect(requests[0].destroy).toHaveBeenCalled();
});

it("uses public IPv6 directly if A is absent", async () => {
  resolver.resolve4.mockRejectedValue({ code: "ENODATA" }); await call();
  expect(requests[0].options).toMatchObject({ hostname: "2001:4860:4860::8888", family: 6 });
});

it.each(["Host", "Connection", "Transfer-Encoding", "Proxy-Authorization", "Content-Length"])("rejects overridden transport header %s before network effects", async (name) => {
  await expect(call({ headers: { [name]: "unsafe" } })).rejects.toMatchObject({ code: "EDESTINATION" }); expect(https.request).not.toHaveBeenCalled();
});

it("rejects redirects without making a second connection", async () => {
  respond = (req) => response(req, 302, [], { location: "https://169.254.169.254/latest/meta-data" });
  await expect(call()).rejects.toMatchObject({ code: "EREDIRECT" }); expect(https.request).toHaveBeenCalledTimes(1); expect(requests[0].destroy).toHaveBeenCalled();
});
it("enforces streamed byte limits without buffering the complete response", async () => {
  respond = (req) => response(req, 200, [Buffer.alloc(80), Buffer.alloc(80), Buffer.alloc(100000)]);
  await expect(call({ maxResponseBytes: 100 })).rejects.toMatchObject({ code: "ELIMIT" }); expect(requests[0].incoming.destroy).toHaveBeenCalled();
});
it("rejects compressed responses and oversized content-length", async () => {
  respond = (req) => response(req, 200, [], { "content-encoding": "gzip" }); await expect(call()).rejects.toMatchObject({ code: "ELIMIT" });
  respond = (req) => response(req, 200, [], { "content-length": "999999999" }); await expect(call()).rejects.toMatchObject({ code: "ELIMIT" });
});
it("sanitizes transport errors rather than exposing URL or credential details", async () => {
  respond = (req) => req.emit("error", new Error("SENSITIVE-URL-OR-CREDENTIAL"));
  await expect(call()).rejects.toThrow("Integration transport failed");
});
it("keeps a deadline through slow response bodies and destroys underlying work", async () => {
  jest.useFakeTimers(); respond = (req) => {
    const incoming: any = new EventEmitter(); incoming.statusCode = 200; incoming.headers = {}; incoming.destroy = jest.fn();
    req.incoming = incoming; req.emit("response", incoming); // headers arrive, body never completes
  };
  const result = call().catch((error) => error);
  await jest.advanceTimersByTimeAsync(1001);
  expect(await result).toMatchObject({ code: "ETIMEDOUT" }); expect(requests[0].destroy).toHaveBeenCalled();
});
it("cancels pending DNS queries within the DNS deadline", async () => {
  jest.useFakeTimers(); const rejects: Array<(value: unknown) => void> = [];
  resolver.resolve4.mockImplementation(() => new Promise((_resolve, reject) => rejects.push(reject)));
  resolver.resolve6.mockImplementation(() => new Promise((_resolve, reject) => rejects.push(reject)));
  resolver.cancel.mockImplementation(() => rejects.forEach((reject) => reject({ code: "ECANCELLED" })));
  const result = call({ timeoutMs: 10000 }).catch((error) => error); await jest.advanceTimersByTimeAsync(1501);
  expect(await result).toMatchObject({ code: "EDNS" }); expect(resolver.cancel).toHaveBeenCalled(); expect(https.request).not.toHaveBeenCalled();
});
it("bounds admission during outages and releases slots only after destroyed requests close", async () => {
  jest.useFakeTimers(); respond = () => undefined;
  const pending = Array.from({ length: 32 }, () => call().catch((error) => error));
  await jest.advanceTimersByTimeAsync(0);
  const before = [ (Resolver as jest.Mock).mock.calls.length, resolver.resolve4.mock.calls.length, resolver.resolve6.mock.calls.length, (https.request as jest.Mock).mock.calls.length ];
  const error = await call().catch((failure) => failure);
  expect(error).toMatchObject({ code: "ECAPACITY" });
  expect(isIntegrationHttpRetryableError(error)).toBe(true);
  expect([ (Resolver as jest.Mock).mock.calls.length, resolver.resolve4.mock.calls.length, resolver.resolve6.mock.calls.length, (https.request as jest.Mock).mock.calls.length ]).toEqual(before);
  await jest.advanceTimersByTimeAsync(1001); await Promise.all(pending);
  expect(requests).toHaveLength(32); expect(requests.every((req) => req.closed)).toBe(true);
});
it.each(["destination", "request size", "response size"])("keeps actual %s rejection non-retryable", async (violation) => {
  if (violation === "response size") respond = (req) => response(req, 200, [Buffer.alloc(101)]);
  const overrides = violation === "destination" ? { url: "http://partner.example.test" }
    : violation === "request size" ? { body: "x".repeat(1024 * 1024) } : { maxResponseBytes: 100 };
  const error = await call(overrides).catch((failure) => failure);
  expect(error).toMatchObject({ code: violation === "destination" ? "EDESTINATION" : "ELIMIT" });
  expect(isIntegrationHttpRetryableError(error)).toBe(false);
  if (violation !== "response size") {
    expect(resolver.resolve4).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  }
});
it("does not infer permission from a matching hostname suffix or different provider", () => {
  expect(() => validateIntegrationUrl("https://partner.example.test", "unapproved")).toThrow("allowlisted");
});

it("bounds TLS connection time separately from the overall request deadline", async () => {
  jest.useFakeTimers(); handshake = false; respond = () => undefined;
  const result = call({ timeoutMs: 10000 }).catch((error) => error);
  await jest.advanceTimersByTimeAsync(3001);
  expect(await result).toMatchObject({ code: "ETIMEDOUT" }); expect(requests[0].socket.destroy).toHaveBeenCalled();
});
it("destroys sockets on unexpected protocol upgrades", async () => {
  respond = (req) => req.emit("upgrade", {}, req.socket);
  await expect(call()).rejects.toMatchObject({ code: "EREDIRECT" }); expect(requests[0].socket.destroy).toHaveBeenCalled();
});

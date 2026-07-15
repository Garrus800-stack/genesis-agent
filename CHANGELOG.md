## [7.9.38]

Genesis speaks standard MCP Streamable HTTP, and a trusted-loopback door opens just wide enough for a peer experiment.

The MCP client transport had a hole: the non-SSE branch called an implementation that did not exist in the file, hidden behind a type-cast so the checker never complained. It is now real — POST-first JSON-RPC to the endpoint, the Mcp-Session-Id read from the initialize response header and echoed on every following request, and responses parsed whether they arrive as plain JSON or as a single SSE message on the POST. A low-level request layer replaces the old body-only POST, which had thrown the response headers away (making the session id unreachable) and rejected an empty body as invalid JSON — but the spec-required initialized notification answers 202 with no body, so that empty answer is now tolerated instead of fatal. The client never sends an Origin header, since a forgeable Origin from a non-browser client adds no authentication value.

Reaching a peer on the same machine needs a way past the SSRF wall that has always blocked loopback and private addresses. That way is a deliberately narrow, per-server opt-in: an exact loopback host only — no substring match, so a look-alike like 127.0.0.1.evil.com stays blocked — and only when a bearer token is present. A trustLoopback entry without a token is refused outright rather than silently allowed, and every other private range stays blocked even with the opt-in set. The legacy SSE transport, still the default, is untouched. The client now reports Genesis's real version to peers instead of a stale hard-coded string. A contract suite proves the whole surface against a real Streamable-HTTP server — POST-first, the session roundtrip, both response shapes, the 202 tolerance, default-deny loopback, the token requirement, the look-alike rejection, and no Origin on the wire — and pins 20 behaviours.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive

# Usage reads

Who calls the hosted servers (`mcp.fabrica.land/mcp`, `mcp-testnet.fabrica.land/mcp`), which tools, and how often they fail. One dated note per read (`YYYY-MM-DD.md`), weekly for the first month after the log line shipped, then monthly.

## The log line

`src/usage-log.ts` writes one JSON line to stdout per POST, which Vercel keeps as the function's runtime logs:

```json
{"event":"mcp_request","network":"ethereum","calls":[{"method":"tools/call","tool":"get_land_property"}],"userAgent":"claude-user/1.0","status":200,"outcome":"ok","durationMs":412}
```

- `calls`: JSON-RPC `method`, the `tool` name on `tools/call`, and `client` (`name/version` from `clientInfo`) on `initialize`. At most 10 per batch.
- `onFabrica`: on lines with a `find_us_parcel` call only. `true` when every query that settled named a parcel on Fabrica (a single match with a token, an ambiguous list or a fallback match that includes one), `false` when every settled query found a parcel that is not on Fabrica, `mixed` when both. Left out when no query settled (an error, no match, an ambiguous list with no token, a failed token check). A `queries` list counts each of its queries. No query text, addresses or parcel numbers.
- `outcome`: one per request, not per call; in a batch, any failing call marks the whole line. `ok`, `tool_error` (the tool returned `isError`), `rpc_error` (JSON-RPC error, such as invalid arguments), `http_error` (status 400 and up), `aborted` (the client disconnected before the response finished).
- Never in the line: tool arguments, wallet addresses, IPs. Client-supplied text (clientInfo, user agent) has hex runs, IPs and emails replaced with `[redacted]`; unknown methods and tool names log as `other`.

## Taking a read

1. Vercel dashboard, team `fabrica`, project `fabrica-mcp` (then `fabrica-mcp-testnet`), Logs, filter the message on `mcp_request`, export for the period. Or `vercel logs` for the project.
2. Count: requests per day, distinct `client` values on `initialize` and distinct `userAgent` values (leave out our own harness, `http-test`, `usage-test`), calls per `tool`, `find_us_parcel` lines by `onFabrica` (Fabrica property or any land), error rate (lines with a `tools/call` whose `outcome` is not `ok`, over all lines with a `tools/call`; a request-level rate), p50/p95 `durationMs`.
3. Write `docs/usage/YYYY-MM-DD.md`: period, distinct external clients, calls per tool, error rate, anything surprising.

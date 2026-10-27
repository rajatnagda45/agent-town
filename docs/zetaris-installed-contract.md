# Installed Zetaris SQL contract

The `installed-sql-v1` transport implements the installed `docs.yaml` contract
(reference supplied at `I:\Downloads\docs.yaml`):

- `POST /api/v1.0/query/sql/start`, body `{ select, pageLimit }`.
- `GET /api/v1.0/query/sql/page`, query `queryToken`, `pageLimit`, `pageNumber`.
- `DELETE /api/v1.0/query/sql/close/{queryToken}`, with the token URL-encoded.
- Each request sends bearer authorization, a fresh UUID `X-Request-ID`, and integer `X-Org-ID`.

Responses use `records`, `queryToken`, `pageNumber`, `totalCount`, and `totalPages`.
The opening response also requires `pageLimit`. The next request uses the previous
response's page number plus one; `hasMore` is derived only from `pageNumber < totalPages`.
The optional `records` field may be omitted for an explicitly empty result.
An acquired token is closed on success, page failure, invalid metadata, or a configured limit.
If opening fails before a token can be decoded, there is no token available for client cleanup.

The existing 100-row total, 100-row page maximum, 10-page configuration maximum,
2,000,000-byte response limit, and bounded request timeouts remain unchanged.
The custom transport remains available only with an explicit response parser; its
legacy request mapping is covered by the existing data-source tests.

Startup and the read-only probe select the installed profile. `ZETARIS_ROWS_KEY`
must be `records`, `ZETARIS_QUERY_TOKEN_KEY` must be `queryToken`, and
`ZETARIS_ORG_ID` is required. `ZETARIS_HAS_MORE_KEY` is not used. Local HTTP
requires `ZETARIS_ALLOW_LOOPBACK_HTTP=1`; non-loopback HTTP remains rejected.
Credentials stay in ignored local settings and are not logged.

Both server entry points now pass the approved four-source inventory demo mapping.
The private environment selects the reader mode; no credentials or local mode settings
are committed. The mapped tables contain labelled synthetic samples, not production
warehouse records. Contract tests use mocked HTTP responses; transport compatibility does
not establish a passing live investigation gate.

The installed transport now retains `totalCount`. The bounded reader requires a stable count across pages and exactly that many collected records before returning evidence. Pages beyond the declared page range, positive totals on zero-page responses, and record arrays larger than the declared count are rejected. Cleanup remains mandatory after token acquisition; a failed cleanup cannot turn a failed read into success or hide the primary read failure. Fetch exceptions are replaced with bounded network/timeout messages so endpoint and credential details are not echoed.

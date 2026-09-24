# DSH 0.1.5-rc.2 desktop notifications

The desktop shell reads durable Session audit events through authenticated
`session/list` and `session/page` RPCs. It never opens `$events`, which is a
waterfall participant rather than a passive subscription: an observer that
does not answer can hold a pending approval indefinitely.

After the main BrowserWindow follows the process-token URL, DSH mints an
HttpOnly cookie bound to the `127.0.0.1:<port>` authority. The main process
reads that exact cookie from the BrowserWindow's Electron session and keeps it
in memory only. No launch token or cookie is logged. When the cookie is not yet
available, the poller waits; a new runtime port starts a fresh baseline.

Every two seconds, the poller lists visible Sessions and uses each attached
Session's projection cursor to page its event log. Pages are read backwards
until the previous cursor, then processed in sequence. The first scan of a
running Session pages back to the most recent turn boundary and only reports
`approval/asked` events in an open turn without a matching
`approval/decided`. A first-seen completed Session is inspected only when its
list activity is newer than bridge attachment; the most recent `turn/end` is
reported only when that event itself is newer than attachment. Earlier history
is not replayed, including after a runtime restart.
Subsequent scans resolve pending approvals by durable approval ID and notify
turn endings by `turn/end.reason.kind`: only `completed` is called complete;
`aborted`, `blocked`, `error`, `max-tokens`, and `interrupted` have separate
wording. Unknown extension reasons use the neutral “本轮已结束”.

Limits: live attached Sessions normally surface at the next two-second poll,
plus RPC processing time. Cold list projection hints may lag the event log or
be absent; `session/page` requires an explicit `throughSeq`, so the shell cannot
safely infer a newer cursor. A fast completed Session with a stale or missing
cold cursor can still be missed. A turn already in progress before bridge
attachment is treated as historical if its list activity predates attachment.
Subagent history requires an address with parent and mode and is
currently skipped. Non-durable `api-session/error` emissions, including some
activation failures before a turn opens, are outside this read-only route.
`session/follow` is not used because following a prepared ordinary Session can
activate its Agent. The poller never submits an approval outcome or calls a
mutating endpoint.
If a journal cannot be read contiguously, including after the 200-page safety
budget, the bridge reports degraded health, logs the affected Session, and
shows a once-per-incident “通知监测受限” notice when error notifications are enabled.

The adapter is pinned to bundled rc.2. Its installed package declares the
durable approval fields (`id`, `toolName`, optional `callId`/`reason`) and paired
decision in `@deepseek-ai/dsh-user-approval/lib/types/types.d.ts:29-51`; the
actual append calls are in `lib/index.js:131-145`. The six built-in turn-end
reasons are declared in `@deepseek-ai/dsh-session/lib/types/types.d.ts:165-198`.
The Host page method reads a contiguous log prefix and returns ordered records
in `@deepseek-ai/dsh-api-session-controller/lib/index.js:1365-1386`.

Verification completed: unit tests cover pagination, pending recovery, cookie
gating, and reconnect. A fresh temporary DSH_HOME ran bundled rc.2, exchanged
its launch token for one browser cookie, and accepted authenticated list/page
RPC envelopes. After creating and renaming a temporary Session, `session/list`
returned it at cursor 3 and `session/page` returned seq 0–3 in ascending order.
The temporary process and profile were removed. **Still required before
release:** a real BrowserWindow approval and turn-notification acceptance run
under a temporary profile. The temporary RPC check did not exercise an actual
approval or turn ending; the fixtures for those events are backed by the
installed package contract above.

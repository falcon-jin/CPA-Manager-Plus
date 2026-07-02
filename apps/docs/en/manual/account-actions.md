# Account Action Queue

Account Action Queue centralizes auth-related candidates detected from Monitoring. It is not a request-details page. It lists accounts that may need human action.

If you need the failed request itself, start with [Monitoring](./monitoring.md).

## When Candidates Appear

When Monitoring captures revoked tokens, invalid OAuth, auth-file failures, or similar signals, CPAMP can add the account to the candidate queue.

The queue is controlled by `USAGE_ACCOUNT_ACTIONS_ENABLED` or the Configuration switch. Automatic disable also requires `USAGE_ACCOUNT_ACTIONS_AUTO_DISABLE`, and depends on the queue being enabled.

## Fields

- **Account**: account identity resolved from request events, auth files, or `auth_index`.
- **Auth file**: related file name.
- **Suggested action**: enable, resolve, ignore, or delete auth file.
- **Reason**: CPAMP's summary of why the candidate exists.
- **First seen / last seen**: whether the issue is persistent.
- **Hits**: how often the signal appeared.
- **Status**: pending, ignored, resolved, or failed.
- **Evidence**: sanitized failure summary and related request context.

## Handling Candidates

1. Open evidence first and confirm the issue is not a one-off upstream error.
2. If the account was already reauthorized or handled manually, mark it resolved.
3. If the candidate is a false positive or not worth action, ignore it.
4. If an auth file was disabled but is now safe to use, enable it.
5. Delete an auth file only after confirming the account is invalid and no longer used.

Before deleting, confirm that the same auth file is not used by another model or project. Delete affects history and future tracking.

## Related Pages

- Need failure details: [Monitoring](./monitoring.md).
- Need reauth: [OAuth Login](./oauth.md).
- Need account enable/disable: [Auth Files](./auth-files.md).
- Need Codex quota or state: [Codex Inspection](./codex-inspection.md).

## Usage Advice

Use this queue for recurring auth-class problems. It is not meant for one-off network errors, upstream 5xx, or missing model names. If unsure, ignore or observe first; do not delete immediately.

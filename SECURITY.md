# Security policy

`dsh-approve-for-me` may approve a sandbox escalation without an immediate human click. Treat a defect in request correlation, rule matching, model isolation, or fallback behavior as a security issue.

Report vulnerabilities privately through GitHub Security Advisories. Do not include API keys, credentials, complete prompts, private workspace paths, or unredacted tool arguments in a report.

The supported beta release line is `0.1.x`. A request is never automatically approved when it cannot be tied to one active tool call, when its configuration is invalid, when the reviewer is unavailable, or when the reviewer response is not a valid explicit allow decision.

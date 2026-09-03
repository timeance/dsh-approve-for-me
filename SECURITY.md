# Security policy

`dsh-approve-for-me` may approve a sandbox escalation without an immediate human click. Treat a defect in request correlation, rule matching, model isolation, or fallback behavior as a security issue.

Report vulnerabilities privately through GitHub Security Advisories. Do not include API keys, credentials, complete prompts, private workspace paths, or unredacted tool arguments in a report.

The supported release line is `0.3.x` on DeepSeek Harness `0.1.1-rc.2`, `0.1.2-alpha.1`, `0.1.2-alpha.4`, and `0.1.2-rc.1`. The Web client uses Harness's shared settings schema service; the plugin does not ship a second local schema rehydrator. A request is never automatically approved when it cannot be tied to one active tool call, when its configuration is invalid, when the reviewer is unavailable, or when the reviewer response is not a valid explicit allow decision.

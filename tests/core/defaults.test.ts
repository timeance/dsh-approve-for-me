import { describe, expect, it } from "vitest";

import { APPROVE_FOR_ME_DEFAULTS } from "../../src/core/defaults.ts";
import { parseApprovalSettings } from "../../src/core/settings.ts";

describe("APPROVE_FOR_ME_DEFAULTS", () => {
  it("is valid and keeps the command allowlist empty", () => {
    expect(parseApprovalSettings(APPROVE_FOR_ME_DEFAULTS)).toEqual({
      ok: true,
      settings: APPROVE_FOR_ME_DEFAULTS,
    });
    expect(APPROVE_FOR_ME_DEFAULTS.rules.commandPrefixes).toEqual([]);
  });
});

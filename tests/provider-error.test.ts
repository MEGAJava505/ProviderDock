import { describe, expect, it } from "vitest";
import {
  providerErrorFromUpstream,
  providerErrorGuidance,
} from "../src/index.js";

describe("provider errors", () => {
  it("classifies provider-owned resource failures", () => {
    expect(
      providerErrorFromUpstream(400, {
        message:
          "The requested item was created under a different Azure OpenAI resource.",
      }).type,
    ).toBe("RESOURCE_SCOPE_MISMATCH");
    expect(
      providerErrorFromUpstream(400, {
        message: "The encrypted content for item rs_123 could not be verified.",
      }).type,
    ).toBe("RESOURCE_SCOPE_MISMATCH");
    expect(
      providerErrorFromUpstream(400, {
        message: "Use the same resource that created the item to access it.",
      }).type,
    ).toBe("RESOURCE_SCOPE_MISMATCH");
  });

  it("provides actionable resource-scope guidance", () => {
    expect(providerErrorGuidance("RESOURCE_SCOPE_MISMATCH")).toEqual({
      explanation:
        "Provider-owned reasoning state was created by a different upstream resource.",
      suggestedAction:
        "Start a new conversation on the selected route or return to the route that created the reasoning state.",
    });
  });

  it("keeps unrelated HTTP 400 failures as invalid requests", () => {
    expect(
      providerErrorFromUpstream(400, {
        message: "The input schema is invalid.",
      }).type,
    ).toBe("INVALID_REQUEST");
  });
});

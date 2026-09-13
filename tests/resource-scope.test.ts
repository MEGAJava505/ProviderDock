import { describe, expect, it } from "vitest";
import {
  resourceScopeKey,
  stripResourceScopeMetadata,
  tagProviderOwnedItems,
  validateProviderOwnedInput,
} from "../src/index.js";

const scope = {
  providerId: "azure-a",
  baseUrl: "https://azure-a.test/v1",
  protocol: "openai-responses",
  upstreamResourceId: "resource-a",
} as const;

describe("resource scope", () => {
  it("creates stable key", () =>
    expect(resourceScopeKey(scope)).toBe(
      JSON.stringify([
        scope.providerId,
        scope.baseUrl,
        scope.protocol,
        scope.upstreamResourceId,
      ]),
    ));

  it("tags reasoning", () =>
    expect(
      tagProviderOwnedItems(
        {
          output: [
            { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
            { type: "message", id: "msg_1" },
          ],
        },
        scope,
      ),
    ).toMatchObject({
      output: [
        {
          type: "reasoning",
          providerdock_resource_scope: resourceScopeKey(scope),
        },
        { type: "message", id: "msg_1" },
      ],
    }));

  it("accepts same", () =>
    expect(() =>
      validateProviderOwnedInput(
        {
          input: [
            {
              type: "reasoning",
              id: "rs_1",
              encrypted_content: "opaque",
              providerdock_resource_scope: resourceScopeKey(scope),
            },
          ],
        },
        scope,
      ),
    ).not.toThrow());

  it("rejects foreign", () =>
    expect(() =>
      validateProviderOwnedInput(
        {
          input: [
            {
              type: "reasoning",
              id: "rs_foreign",
              encrypted_content: "foreign",
              providerdock_resource_scope: "different-scope",
            },
          ],
        },
        scope,
      ),
    ).toThrow(/RESOURCE_SCOPE_MISMATCH/));

  it("rejects untagged provider-owned reasoning ids", () =>
    expect(() =>
      validateProviderOwnedInput(
        {
          input: [{ type: "reasoning", id: "rs_untagged" }],
        },
        scope,
      ),
    ).toThrow(/RESOURCE_SCOPE_MISMATCH/));

  it("tags reasoning nested under response and event item containers", () => {
    const tagged = tagProviderOwnedItems(
      {
        item: { type: "reasoning", id: "rs_nested", encrypted_content: "opaque" },
        response: {
          output: [
            { type: "reasoning", id: "rs_response", encrypted_content: "opaque" },
          ],
        },
      },
      scope,
    );
    expect(tagged).toMatchObject({
      item: { providerdock_resource_scope: resourceScopeKey(scope) },
      response: {
        output: [{ providerdock_resource_scope: resourceScopeKey(scope) }],
      },
    });
  });

  it("leaves ordinary message ids untouched", () => {
    const payload = {
      output: [{ type: "message", id: "rs_message_but_not_reasoning" }],
    };
    expect(tagProviderOwnedItems(payload, scope)).toEqual(payload);
  });

  it("strips only local resource metadata before forwarding upstream", () => {
    expect(
      stripResourceScopeMetadata({
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "opaque",
            providerdock_resource_scope: resourceScopeKey(scope),
            provider_extension: { preserved: true },
          },
        ],
      }),
    ).toEqual({
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "opaque",
          provider_extension: { preserved: true },
        },
      ],
    });
  });
});

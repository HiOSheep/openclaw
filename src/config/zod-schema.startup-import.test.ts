// Guards lazy schema compilation and startup imports against loading heavy runtime modules.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providersWhatsappImportMock = vi.hoisted(() => vi.fn());

describe("OpenClawSchema startup imports", () => {
  beforeEach(() => {
    providersWhatsappImportMock.mockClear();
    vi.doMock("./zod-schema.providers-whatsapp.js", () => {
      providersWhatsappImportMock();
      return {};
    });
  });

  it("compiles generic channel validation lazily without loading provider-specific schemas", async () => {
    const runtime = await importFreshModule<typeof import("./zod-schema.js")>(
      import.meta.url,
      "./zod-schema.js?scope=startup-generic-channels",
    );

    const schema = runtime.OpenClawSchema;
    const { _zod: schemaInternals } = schema;
    // Zod's pinned native compiler records its validator after the first synchronous parse.
    expect(schemaInternals.bag.validator).toBeUndefined();

    const config = {
      worktreeRoot: "  ~/worktrees  ",
      channels: {
        defaults: {
          groupPolicy: "open",
          botLoopProtection: {
            maxEventsPerWindow: 4,
            windowSeconds: 90,
            cooldownSeconds: 30,
          },
        },
        discord: {},
      },
    };

    const parsed = schema.safeParse(config);
    expect(parsed).toMatchObject({
      success: true,
      data: { worktreeRoot: "~/worktrees", channels: config.channels },
    });

    const validator = schemaInternals.bag.validator;
    expect(validator).toBeTypeOf("function");
    expect(schema.safeParse(config)).toEqual(parsed);
    expect(schemaInternals.bag.validator).toBe(validator);

    expect(schema.safeParse({ talk: { agentId: "missing" } })).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            code: "custom",
            path: ["talk", "agentId"],
            message: 'Unknown agent id "missing" (not in agents.entries).',
          },
        ],
      },
    });

    expect(providersWhatsappImportMock).not.toHaveBeenCalled();
  });
});

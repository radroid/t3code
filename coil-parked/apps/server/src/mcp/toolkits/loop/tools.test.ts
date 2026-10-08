// @effect-diagnostics nodeBuiltinImport:off
/**
 * TESTS.md §7, case 118 and the registration half of the phase: the three tools reach a
 * provider through the same `McpServer` upstream's preview toolkit registers on, and their
 * schemas are the shapes the console and the agent were promised.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { McpServer, Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { LoopToolkitRegistrationLive } from "./handlers.ts";
import { LOOP_TOOL_NAMES, LoopToolkit } from "./tools.ts";

/**
 * A described field may sit inside the `anyOf` an optional parameter compiles to, so the
 * check recurses the same way upstream's preview toolkit test does.
 */
const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

const toolNames = Effect.map(McpServer.McpServer, (server) =>
  server.tools.map((entry) => entry.tool.name),
);

it.effect("registers all three tools on the shared MCP server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-registration-" });

    const names = yield* toolNames.pipe(
      Effect.provide(
        LoopToolkitRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(ServerConfig.layerTest(root, root)),
        ),
      ),
    );

    expect([...names].sort()).toEqual([...LOOP_TOOL_NAMES].sort());
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.orDie),
);

it.effect("registers alongside upstream's preview toolkit rather than replacing it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-registration-" });

    // The same merge `McpHttpServer.layer` performs, minus the HTTP transport: if the two
    // registrations ever stopped sharing one `McpServer` instance, one set would vanish.
    const names = yield* toolNames.pipe(
      Effect.provide(
        Layer.mergeAll(
          McpHttpServer.PreviewToolkitRegistrationLive,
          LoopToolkitRegistrationLive,
        ).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(ServerConfig.layerTest(root, root)),
          Layer.provide(PreviewAutomationBroker.layer),
        ),
      ),
    );

    for (const name of LOOP_TOOL_NAMES) assert.include(names, name);
    assert.include(names, "preview_snapshot");
    assert.include(names, "preview_status");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.orDie),
);

it("exports described object schemas the agent can fill in without guessing", () => {
  for (const tool of Object.values(LoopToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    // Attribution is the credential's job. A thread id in the arguments would be a value
    // the model can get wrong, and the handler would have to decide whether to trust it.
    expect(
      schema.properties?.threadId,
      `${tool.name} must not accept a thread id from the model`,
    ).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

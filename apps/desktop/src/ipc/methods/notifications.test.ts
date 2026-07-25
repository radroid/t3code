import { assert, describe, it } from "@effect/vitest";
import type { DesktopNotificationRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ElectronNotification from "../../electron/ElectronNotification.ts";
import { SHOW_NOTIFICATION_CHANNEL } from "../channels.ts";
import { showNotification } from "./notifications.ts";

const request = {
  id: "thread-1",
  title: "T3 Code needs your input",
  body: "Claude is waiting on your answer.",
  environmentId: "local",
  threadId: "thread-1",
} satisfies DesktopNotificationRequest;

describe("showNotification", () => {
  it("is registered on the renderer-facing notification channel", () => {
    assert.equal(showNotification.channel, SHOW_NOTIFICATION_CHANNEL);
    assert.equal(SHOW_NOTIFICATION_CHANNEL, "desktop:show-notification");
  });

  it.effect("forwards the decoded request to the native notification service", () =>
    Effect.gen(function* () {
      const shownRef = yield* Ref.make<readonly DesktopNotificationRequest[]>([]);

      yield* showNotification.handler({ ...request }).pipe(
        Effect.provide(
          Layer.mock(ElectronNotification.ElectronNotification)({
            show: (shown) => Ref.update(shownRef, (previous) => [...previous, shown]),
          }),
        ),
      );

      assert.deepEqual(yield* Ref.get(shownRef), [request]);
    }),
  );

  it.effect("rejects a malformed request instead of raising a notification", () =>
    Effect.gen(function* () {
      const shownRef = yield* Ref.make<readonly DesktopNotificationRequest[]>([]);

      const exit = yield* Effect.exit(
        showNotification.handler({ id: "thread-1" }).pipe(
          Effect.provide(
            Layer.mock(ElectronNotification.ElectronNotification)({
              show: (shown) => Ref.update(shownRef, (previous) => [...previous, shown]),
            }),
          ),
        ),
      );

      assert.equal(exit._tag, "Failure");
      assert.deepEqual(yield* Ref.get(shownRef), []);
    }),
  );
});

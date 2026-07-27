/**
 * Durable Web Push subscription store.
 *
 * A single JSON file (in the server state dir) holding the browser push subscriptions
 * registered against this environment, keyed by endpoint. Rehydrated on boot so
 * subscriptions survive a restart. Mutations are serialized through a `SynchronizedRef` and
 * persisted atomically inside the critical section.
 *
 * Deliberately NOT a DB migration: the migration registry is upstream-owned, and adding to it
 * would buy permanent conflict surface for what one JSON file does fine. Mirrors
 * t3x/autoResume/state.ts.
 *
 * @module t3x/webPush/state
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

export const PushSubscriptionRecord = Schema.Struct({
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  /** The auth session (device) that registered this subscription; for future cleanup. */
  sessionId: Schema.String,
  createdAt: Schema.String,
});
export type PushSubscriptionRecord = typeof PushSubscriptionRecord.Type;

export const WebPushState = Schema.Struct({
  version: Schema.Literal(1),
  subscriptions: Schema.Record(Schema.String, PushSubscriptionRecord),
});
export type WebPushState = typeof WebPushState.Type;

const EMPTY_STATE: WebPushState = { version: 1, subscriptions: {} };

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(WebPushState));

export interface PushSubscriptionStoreShape {
  readonly list: Effect.Effect<ReadonlyArray<PushSubscriptionRecord>>;
  readonly upsert: (record: PushSubscriptionRecord) => Effect.Effect<void>;
  readonly removeByEndpoint: (endpoint: string) => Effect.Effect<void>;
}

export class PushSubscriptionStore extends Context.Service<
  PushSubscriptionStore,
  PushSubscriptionStoreShape
>()("t3/t3x/webPush/state/PushSubscriptionStore") {}

export const makePushSubscriptionStore = (
  stateFilePath: string,
): Effect.Effect<PushSubscriptionStoreShape, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;

    // Rehydrate. Distinguish an unreadable file (I/O error) from a fresh/corrupt one so a
    // transient read error does not overwrite still-valid subscriptions with an empty file.
    const fileExists = yield* fs.exists(stateFilePath).pipe(Effect.orElseSucceed(() => false));
    let initial: WebPushState = EMPTY_STATE;
    let persistEnabled = true;
    if (fileExists) {
      const contents = yield* fs.readFileString(stateFilePath).pipe(
        Effect.map((c): string | null => c),
        Effect.orElseSucceed(() => null),
      );
      if (contents === null) {
        persistEnabled = false;
        yield* Effect.logWarning(
          "t3x web-push: state file present but unreadable; running in-memory only this session so the existing file is not overwritten",
          { stateFilePath },
        );
      } else {
        initial = yield* decodeState(contents).pipe(Effect.orElseSucceed(() => EMPTY_STATE));
      }
    }

    const ref = yield* SynchronizedRef.make<WebPushState>(initial);

    const persist = (state: WebPushState): Effect.Effect<void> => {
      if (!persistEnabled) return Effect.void;
      return writeFileStringAtomically({
        filePath: stateFilePath,
        contents: `${JSON.stringify(state)}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathSvc),
        Effect.catch((cause) =>
          Effect.logWarning("t3x web-push: failed to persist state", { stateFilePath, cause }),
        ),
      );
    };

    const mutate = (f: (state: WebPushState) => WebPushState) =>
      SynchronizedRef.updateEffect(ref, (state) => {
        const next = f(state);
        return persist(next).pipe(Effect.as(next));
      });

    return {
      list: SynchronizedRef.get(ref).pipe(
        Effect.map((state) => Object.values(state.subscriptions)),
      ),

      upsert: (record) =>
        mutate((state) => ({
          ...state,
          subscriptions: { ...state.subscriptions, [record.endpoint]: record },
        })),

      removeByEndpoint: (endpoint) =>
        mutate((state) => {
          // `Object.hasOwn`, not truthiness: `endpoint` is caller-controlled via the HTTP
          // route, so a value like `__proto__` must not resolve on Object.prototype.
          if (!Object.hasOwn(state.subscriptions, endpoint)) return state;
          const next = { ...state.subscriptions };
          delete next[endpoint];
          return { ...state, subscriptions: next };
        }),
    } satisfies PushSubscriptionStoreShape;
  });

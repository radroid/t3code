import { describe, expect, it } from "vite-plus/test";

import { serializePushSubscription, urlBase64ToUint8Array } from "./push.logic";

describe("urlBase64ToUint8Array", () => {
  it("decodes a URL-safe base64 string with '-' and '_' substitutions", () => {
    // "\xff\xef\xff" encodes to "/+//" in standard base64 -> "_-__" URL-safe.
    const decoded = urlBase64ToUint8Array("_-__");
    expect(Array.from(decoded)).toEqual([0xff, 0xef, 0xff]);
  });

  it("restores missing padding", () => {
    // "Ma" (no padding) is standard base64 for a single byte 0x31 ('1').
    const decoded = urlBase64ToUint8Array("MQ");
    expect(Array.from(decoded)).toEqual([0x31]);
  });

  it("round-trips arbitrary bytes encoded as URL-safe base64 without padding", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const urlSafe = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(Array.from(urlBase64ToUint8Array(urlSafe))).toEqual(Array.from(bytes));
  });
});

describe("serializePushSubscription", () => {
  it("returns endpoint + keys when complete", () => {
    expect(
      serializePushSubscription({
        endpoint: "https://push.example/abc",
        keys: { p256dh: "PUB", auth: "AUTH" },
      }),
    ).toEqual({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "PUB", auth: "AUTH" },
    });
  });

  it("returns null when the endpoint is missing", () => {
    expect(
      serializePushSubscription({ keys: { p256dh: "PUB", auth: "AUTH" } } as PushSubscriptionJSON),
    ).toBeNull();
  });

  it("returns null when keys are missing", () => {
    expect(
      serializePushSubscription({ endpoint: "https://push.example/abc" } as PushSubscriptionJSON),
    ).toBeNull();
  });

  it("returns null when only one key is present", () => {
    expect(
      serializePushSubscription({
        endpoint: "https://push.example/abc",
        keys: { p256dh: "PUB" },
      } as PushSubscriptionJSON),
    ).toBeNull();
  });
});

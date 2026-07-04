/**
 * Receive the Triki IMU stream in Node — no browser required.
 *
 * Prerequisites (from the package directory):
 *   npm install @abandonware/noble   # optional native dependency
 *   npm run build                    # produces dist/node.js
 *
 * Then run:
 *   node example/node.mjs
 *
 * macOS grants Bluetooth access per-app, so the first run prompts the terminal
 * (or your IDE) for permission.
 */
import { TrikiController, NobleTransport } from "../dist/node.js";

const triki = new TrikiController({ transport: new NobleTransport() });

triki.on("connectionchange", (state) => console.log("[state]", state));
triki.on("rate", (hz) => console.log("[rate]", hz, "Hz"));
triki.on("orientation", ({ euler }) => {
  const f = (n) => n.toFixed(1).padStart(7);
  console.log(`roll ${f(euler.roll)}   pitch ${f(euler.pitch)}   yaw ${f(euler.yaw)}`);
});

process.on("SIGINT", () => {
  if (triki.state === "disconnected") process.exit(0);
  // Exit once the BLE teardown lands, so the token isn't left connected.
  triki.on("connectionchange", (state) => {
    if (state === "disconnected") process.exit(0);
  });
  triki.disconnect();
  // Fallback: force-exit if the teardown stalls; unref'd so it never holds the loop.
  setTimeout(() => process.exit(0), 1000).unref?.();
});

console.log("Scanning for a TRIKI token… (Ctrl+C to quit)");
try {
  await triki.connect(); // 15 s scan budget by default; Ctrl+C mid-scan rejects
} catch (err) {
  console.error("[connect]", err instanceof Error ? err.message : err);
  process.exit(1);
}

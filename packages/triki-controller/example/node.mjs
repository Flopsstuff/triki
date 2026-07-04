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
import { TrikiController, NobleTransport, ConnectAbortedError } from "../dist/node.js";

const triki = new TrikiController({ transport: new NobleTransport() });

triki.on("connectionchange", (state) => console.log("[state]", state));
triki.on("rate", (hz) => console.log("[rate]", hz, "Hz"));
triki.on("orientation", ({ euler }) => {
  const f = (n) => n.toFixed(1).padStart(7);
  console.log(`roll ${f(euler.roll)}   pitch ${f(euler.pitch)}   yaw ${f(euler.yaw)}`);
});

process.on("SIGINT", () => {
  triki.disconnect(); // kicks off the BLE teardown (fire-and-forget inside the transport)
  // The 'disconnected' event fires synchronously, BEFORE the HCI disconnect is sent —
  // so give the radio a moment instead of exiting from the event.
  setTimeout(() => process.exit(0), 300);
});

console.log("Scanning for a TRIKI token… (Ctrl+C to quit)");
try {
  await triki.connect(); // 15 s scan budget by default; Ctrl+C mid-scan rejects
} catch (err) {
  if (err instanceof ConnectAbortedError) process.exit(0); // user quit during the scan
  console.error("[connect]", err instanceof Error ? err.message : err);
  process.exit(1);
}

/**
 * Node entry point for triki-controller (`triki-controller/node`).
 *
 * Re-exports the full browser API and adds {@link NobleTransport}, a BLE transport
 * backed by the optional `@abandonware/noble` dependency, so the token can be received
 * outside the browser. Keeping it on a separate entry means the default browser bundle
 * never imports noble.
 */
export * from "./index";
export { NobleTransport } from "./transports/noble";
export type { NobleTransportOptions } from "./transports/noble";

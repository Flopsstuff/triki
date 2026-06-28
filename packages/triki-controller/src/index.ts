/** Public API for triki-controller. */

export { TrikiController } from "./controller";
export { MadgwickAHRS, AccelAHRS, quatMul, quatAboutZ, yawRadOf, eulerOf } from "./fusion";
export { VqfAHRS, DEFAULT_TAU_ACC } from "./vqf";
export { FrameParser, decodeCounts } from "./parser";
export {
  startCmd,
  ledCmd,
  NUS_SERVICE,
  NUS_RX,
  NUS_TX,
  NUS_CTRL,
  BATTERY_SERVICE,
  BATTERY_LEVEL,
  HEADER0,
  HEADER1,
  FRAME_LEN,
  START_BASE,
  DEFAULT_ACCEL_SCALE,
  DEFAULT_GYRO_SCALE,
  DEFAULT_RATE_HZ,
  DEFAULT_BETA,
  SUPPORTED_RATES_HZ,
} from "./protocol";

export type { Quaternion, EulerAngles, MadgwickOptions, OrientationFilter } from "./fusion";
export type { VqfOptions } from "./vqf";
export type { RawFrame } from "./parser";
export type { SupportedRateHz } from "./protocol";
export type { Listener, Unsubscribe } from "./emitter";
export type {
  ConnectionState,
  FusionAlgorithm,
  Vec3,
  FrameEvent,
  OrientationEvent,
  TrikiEventMap,
  TrikiControllerOptions,
} from "./events";

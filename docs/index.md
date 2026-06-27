---
layout: home

hero:
  name: Triki
  text: Żabka Triki as a BLE motion controller
  tagline: >
    Notes and tooling for the Żabka "Triki" — a collectible BLE token
    (nRF52810 + LSM6DSL IMU) shaped like a bottle cap. The goal: read its
    accelerometer/gyroscope over BLE and reuse it as a motion controller.
  image:
    src: /img/front.jpg
    alt: Triki token
  actions:
    - theme: brand
      text: Overview
      link: /guide/overview
    - theme: alt
      text: IMU streaming (main goal)
      link: /guide/imu-streaming
    - theme: alt
      text: View on GitHub
      link: https://github.com/Flopsstuff/triki

features:
  - title: Hardware
    details: nRF52810 BLE SoC, LSM6DSL accelerometer/gyroscope, and the rest of the board.
    link: /guide/hardware
  - title: BLE protocol
    details: The Nordic UART Service GATT map, the green-LED control register, and the command interface.
    link: /guide/ble-protocol
  - title: IMU streaming — solved
    details: Live accelerometer + gyroscope over BLE via an 8-byte start command and 14-byte motion frames.
    link: /guide/imu-streaming
  - title: Web Bluetooth controller
    details: An in-browser page that streams the IMU and shows a live 3D orientation cube — no backend.
    link: /guide/controller
  - title: Tooling
    details: bleak scripts for scanning, GATT dumps, and decoding the IMU stream.
    link: /guide/tooling
---

<div style="text-align:center; margin:2.5rem 0 0.5rem;">
  <a href="controller/" target="_blank" rel="noreferrer"><strong>▶ Open the live Web Bluetooth controller</strong></a>
  <div style="opacity:0.7; font-size:0.9em;">streams the token's motion in a Chromium browser — no install</div>
</div>

> Personal project on my own device. No device-identifying values (serial, BLE MAC)
> are published — the browser's device picker selects the token at runtime.

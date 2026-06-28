import { defineConfig } from 'vitepress'

// Published to GitHub Pages at https://flopsstuff.github.io/triki/
// `base` must match the repo name; update it if the repo is renamed/forked.
export default defineConfig({
  base: '/triki/',
  title: 'Triki',
  description: 'Żabka Triki BLE token — reading the accelerometer/gyroscope over BLE (nRF52810 + LSM6DSL)',
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/overview' },
      { text: 'Protocol', link: '/guide/ble-protocol' },
      { text: 'Controller', link: '/guide/controller' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/guide/overview' },
          { text: 'Hardware', link: '/guide/hardware' },
          { text: 'BLE protocol', link: '/guide/ble-protocol' },
          { text: 'IMU streaming', link: '/guide/imu-streaming' },
          { text: 'Tooling', link: '/guide/tooling' },
        ],
      },
      {
        text: 'Controller',
        items: [
          { text: 'Web Bluetooth controller', link: '/guide/controller' },
          { text: 'npm package (triki-controller)', link: '/guide/library' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/Flopsstuff/triki' }],
    search: { provider: 'local' },
  },
})

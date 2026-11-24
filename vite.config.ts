import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      workbox: { navigateFallbackDenylist: [/\/api\//] },
      manifest: {
        name: 'Notes',
        short_name: 'Notes',
        description: 'Samsung Notes–style handwriting notes. Works offline; notes stay on this device.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f6f6f6',
        theme_color: '#f6f6f6',
        launch_handler: { client_mode: 'focus-existing' },
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})

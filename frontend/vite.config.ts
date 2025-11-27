import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    allowedHosts: [
      'spikier-sharen-endermic.ngrok-free.dev'
    ],
  },
  plugins: [react()],
})

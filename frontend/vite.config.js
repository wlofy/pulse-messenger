import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/login': backend,
      '/users': backend,
      '/chats': backend,
      '/messages': backend,
      '/media': backend,
      '/notifications': backend,
      '/push': backend,
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
})

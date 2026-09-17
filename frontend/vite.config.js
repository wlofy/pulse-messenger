import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/login': backend,
      '/signup': backend,
      '/logout': backend,
      '/exists': backend,
      '/profile': backend,
      '/contacts': backend,
      '/groups': backend,
      '/users': backend,
      '/chats': backend,
      '/messages': backend,
      '/media': backend,
      '/notifications': backend,
      '/events': backend,
      '/assistant': backend,
      '/push': backend,
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
})

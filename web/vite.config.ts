import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: {
        main: page('./index.html'),
        hall: page('./hall.html'),
        admin: page('./admin.html'),
      },
    },
  },
  server: {
    port: 5173,
    // Host is forwarded unchanged so the server writes the page's own domain in the login message.
    proxy: {
      '/api': { target: 'http://localhost:8787' },
      '/ws': { target: 'http://localhost:8787', ws: true },
    },
  },
});

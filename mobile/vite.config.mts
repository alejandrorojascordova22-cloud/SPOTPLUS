import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ command, mode }) => {
  const frontendEnv = loadEnv(mode, projectRoot, '');
  const backendEnv = loadEnv(mode, repositoryRoot, '');
  const apiKey = backendEnv.API_KEY?.trim() ?? '';
  const configuredApiUrl = frontendEnv.EXPO_PUBLIC_API_URL?.trim() ?? '';
  const usesLocalProxy =
    command === 'serve' &&
    (!configuredApiUrl || /^https?:\/\/(localhost|127\.0\.0\.1):8000\/?$/.test(configuredApiUrl));

  if (usesLocalProxy && !apiKey) {
    throw new Error('Falta API_KEY en el archivo .env de la raíz del proyecto.');
  }

  return {
    root: projectRoot,
    plugins: [react()],
    resolve: {
      alias: [
        {
          find: /^react-native$/,
          replacement: fileURLToPath(new URL('./src/react-native-web.ts', import.meta.url)),
        },
        {
          find: 'expo-status-bar',
          replacement: fileURLToPath(new URL('./src/status-bar.tsx', import.meta.url)),
        },
        {
          find: '@react-native-community/datetimepicker',
          replacement: fileURLToPath(new URL('./src/date-time-picker.tsx', import.meta.url)),
        },
      ],
      extensions: [
        '.web.mjs',
        '.web.js',
        '.web.mts',
        '.web.ts',
        '.web.jsx',
        '.web.tsx',
        '.mjs',
        '.js',
        '.mts',
        '.ts',
        '.jsx',
        '.tsx',
        '.json',
      ],
    },
    define: {
      'process.env.EXPO_PUBLIC_API_URL': JSON.stringify(
        usesLocalProxy ? '' : configuredApiUrl || 'http://localhost:8000',
      ),
      'process.env.EXPO_PUBLIC_API_KEY': JSON.stringify(
        usesLocalProxy ? '' : frontendEnv.EXPO_PUBLIC_API_KEY ?? '',
      ),
    },
    server: usesLocalProxy
      ? {
          host: '127.0.0.1',
          port: 5173,
          strictPort: false,
          proxy: {
            '/api': {
              target: 'http://127.0.0.1:8000',
              changeOrigin: true,
              configure(proxy) {
                proxy.on('proxyReq', (proxyRequest) => {
                  proxyRequest.setHeader('X-API-Key', apiKey);
                });
              },
            },
            // WebSocket del gráfico en vivo: el proxy agrega la API key al abrir
            // la conexión, así el navegador nunca ve la clave.
            '/ws/vivo': {
              target: 'http://127.0.0.1:8000',
              ws: true,
              changeOrigin: true,
              configure(proxy) {
                proxy.on('proxyReqWs', (proxyRequest) => {
                  proxyRequest.setHeader('X-API-Key', apiKey);
                });
              },
            },
          },
        }
      : undefined,
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});

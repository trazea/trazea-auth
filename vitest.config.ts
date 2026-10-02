import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // tsconfig deja JSX en "preserve" para Next; los tests de la página lo necesitan compilado.
  esbuild: { jsx: 'automatic' },
  // La lógica corre en node; los tests de la página piden jsdom con un comentario de cabecera.
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});

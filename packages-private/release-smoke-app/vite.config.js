import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [
    vue({
      // a prod mismatch must report what mismatched, not only the generic
      // "Hydration completed but contains mismatches."
      features: { prodHydrationMismatchDetails: true },
    }),
  ],
})

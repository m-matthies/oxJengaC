import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
    // Relative base so the build works both on GitHub Pages (/oxJenga/)
    // and when served from any other path
    base: "./",
    // `npm run dev:https` serves over HTTPS with a self-signed certificate,
    // which WebXR needs when the page is opened from a headset on the LAN
    plugins: mode === "https" ? [basicSsl()] : []
}));

# oxJenga
Interactive augmented reality simulation of DNA nanostructures. Forked from https://github.com/zoombya/oxJenga/ by Dr. Michael Matthies.

Try it out now at https://m-matthies.github.io/oxJengaC/. If you have an AR/VR headset, open this URL in the internal web browser and click "START XR".

## Running locally
The app is built with [Vite](https://vitejs.dev/):
```
npm install
npm run dev      # dev server, also exposed on the local network
npm run dev:https  # same over HTTPS (self-signed), needed for WebXR on a headset
npm run build    # production build in dist/
npm run preview  # serve the production build
npm run deploy   # build and publish to GitHub Pages (gh-pages branch)
```

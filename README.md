# VantaCut Studio

VantaCut Studio is an early, local-first video-editing workspace built with React, TypeScript, Vite, and a Tauri 2 desktop shell. The current usable slice focuses on project bins, a frame-based timeline model, basic clip edits, browser-native preview, and `.vcut` project files.

## Run It

Requirements for the web editor: Node.js 20.19 or newer and npm.

```sh
cd apps/desktop
npm install
npm run dev
```

The web editor runs at `http://localhost:5173`. Media files are read locally by the browser and are not uploaded.

For a Tauri desktop build, install Rust stable with rustup, the platform's Tauri prerequisites, and WebView2 on Windows. Then run:

```sh
cd apps/desktop
npm install
npm run tauri -- dev
npm run tauri -- build --bundles nsis
```

The Tauri shell and Windows bundle configuration are present. A Windows x64 GNU GUI executable was cross-compiled in this container with a user-local Rust/MinGW toolchain; it has not been run on Windows. The portable output is `release/windows-x64/VantaCut-Studio.exe` plus its required `WebView2Loader.dll`, or `release/VantaCut-Studio-Windows-x64.zip`. The Windows NSIS setup package was not produced because the Linux NSIS build expects its default stub under `/usr/share/nsis`. The native Rust shell currently hosts the frontend; it does not yet own the project model or render jobs.

## Editing Workflow

- Import video, audio, and still-image files from the media bin. The browser probes media metadata it exposes and caches source blobs in IndexedDB.
- Add media to the timeline, select clips, drag clips between compatible tracks, seek, split, trim, delete, and use undo/redo. Edits and stored positions use integer frames; project frame rate is represented as a rational.
- Preview video through the browser's native `HTMLVideoElement` decoder. Preview support depends on the codecs available in the current WebView/browser.
- Brightness, contrast, saturation, and opacity adjustments are saved with the project. Basic image adjustments are reflected in the preview.
- Save or open `.vcut` JSON project files. Autosave recovery is stored in browser local storage; imported source blobs stay in that browser profile's IndexedDB. A `.vcut` file does not embed media. Missing media is reported, but relinking is not implemented.
- Keyboard shortcuts: `Space` play/pause, `S` split, `Delete` remove, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Y` redo, and arrow keys frame-step (Shift+arrow seeks one second).

The Export dialog intentionally reports that rendering is unavailable. No FFmpeg binary, encoder, native render planner, audio mixer, or GPU pipeline is included. No hardware acceleration or codec support is claimed. Audio preview, waveform generation, transforms, titles, transitions, proxies, and media relinking are not yet implemented.

## Project Layout

- `apps/desktop/src/domain/timeline.ts` — typed project data and deterministic timeline commands/history.
- `apps/desktop/src/storage/mediaStore.ts` — local IndexedDB media cache.
- `apps/desktop/src/App.tsx` and `src/App.css` — editing workspace and interactions.
- `apps/desktop/src-tauri` — Tauri 2 desktop shell, app metadata, restrictive capability, and original platform icons.
- `apps/desktop/e2e` — Playwright workflow tests.

## Checks

Run from `apps/desktop`:

```sh
npm run lint
npm run test
npm run build
npm run test:e2e
```

The timeline suite currently covers rational frame calculations, split/source continuity, trims, move/undo/redo, ripple delete, locked tracks, source bounds, and valid media track placement. In the implementation environment, lint, the production frontend build, all 9 timeline tests, and both Playwright tests pass. Chromium used Linux libraries extracted into a user-local cache; no system packages were installed. The Windows executable was cross-compiled, but the application could not be launched on Windows in this environment, and no NSIS installer was produced.

## Media Engine And Licensing

The preview uses the browser/WebView decoder as a minimal real-media path; it avoids shipping an unverified decoder. This is not a compositing engine. A future render service should sit behind a Rust media-engine interface and use a validated FFmpeg subprocess integration with argument arrays, cancellation, and capability discovery. `ffmpeg-sidecar` is a candidate for progress/event parsing, while `std::process::Command` is sufficient for an initial explicitly configured external FFmpeg. FFmpeg is not bundled: its licensing depends on the build configuration and enabled codecs (LGPL or GPL obligations may apply).

Current direct JavaScript dependency licenses are available in package metadata: React and Vite are MIT, Lucide is ISC, Tauri API/CLI are Apache-2.0 OR MIT, and Playwright is Apache-2.0. No FFmpeg binary or media codec library is distributed. The VantaCut source license has not yet been selected; third-party notices should be added before a distributable release.

Official setup references: [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/), [Tauri 2 security capabilities](https://v2.tauri.app/security/capabilities/), and [FFmpeg legal considerations](https://ffmpeg.org/legal.html).

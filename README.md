# Veo Bridge (CEP Extension Skeleton)

This repository contains a CEP extension scaffold for Adobe After Effects (`AEFT`, version `17+`, including AE 2020+).

## Structure

```text
CSXS/manifest.xml
jsx/host.jsx
index.html
gallery.html
css/style.css
js/csinterface-lite.js
js/sharedState.js
js/main.js
js/gallery.js
js/veoApi.js
scripts/build-zxp.sh
scripts/build-zxp.ps1
scripts/build-pkg.sh
scripts/build-msi.ps1
README.md
.debug (optional)
```

## Build `.zxp` (One Command)

Use included scripts to package and sign this extension into a single `.zxp` file for both macOS and Windows.

### Prerequisite

- Install `ZXPSignCMD` and make it available in `PATH` (or set absolute path in `.zxp-build.env`).

### macOS

```bash
bash scripts/build-zxp.sh
```

### Windows (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-zxp.ps1
```

### First run behavior (automated)

- Creates local config file: `.zxp-build.env`
- Auto-detects `ZXPSignCMD`
- If certificate is missing, creates one at `.certs/VeoBridgeCert.p12`
- Prompts for certificate password when required

### Output

- Signed package is created in `dist/`:
  - `com.veobridge.bundle-<ExtensionBundleVersion>.zxp`

### Notes

- You usually do not need to edit anything manually.
- Optional: set `CERT_PASSWORD` in `.zxp-build.env` to avoid password prompt on every build.
- Install resulting `.zxp` with an extension manager (for example, Anastasiy Extension Manager).

## Build `.pkg` (macOS Installer)

Creates a macOS installer package that installs Veo Bridge into:
`/Library/Application Support/Adobe/CEP/extensions/Veo-Bridge`

```bash
bash scripts/build-pkg.sh
```

Output:
- `dist/Veo-Bridge-<ExtensionBundleVersion>.pkg`

Optional signing:
- set installer signing identity before build:
  ```bash
  export PKG_SIGN_IDENTITY="Developer ID Installer: Your Name (TEAMID)"
  bash scripts/build-pkg.sh
  ```

Notes:
- Without `PKG_SIGN_IDENTITY`, package is unsigned (fine for local testing).

## Build `.msi` (Windows Installer)

Creates a Windows MSI installer (per-user install into `%APPDATA%\Adobe\CEP\extensions\Veo-Bridge`).

Prerequisite:
- Install WiX Toolset v3 and ensure these tools are in `PATH`:
  - `heat.exe`
  - `candle.exe`
  - `light.exe`

Build command:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-msi.ps1
```

Output:
- `dist/Veo-Bridge-<ExtensionBundleVersion>.msi`

## CI Build (GitHub Actions)

This repo includes a manual workflow to build installers and upload artifacts:
- `.zxp` (macOS job)
- `.msi` (Windows job)
- optional `.pkg` (macOS job, toggle in workflow input)

Workflow file:
- `.github/workflows/build-installers.yml`

How to run:
1. Open GitHub -> `Actions` -> `Build Installers`
2. Click `Run workflow`
3. Optionally disable/enable `build_pkg`
4. Wait for jobs to finish
5. Download artifacts:
   - `veobridge-zxp`
   - `veobridge-msi`
   - `veobridge-pkg` (if enabled)

Optional secret:
- `ZXP_CERT_PASSWORD` (recommended)
  - used by CI for `.p12` creation/signing during `.zxp` build
  - if not set, workflow uses temporary fallback password

## Install on macOS

1. Create the CEP extensions directory if needed:
   ```bash
   mkdir -p "$HOME/Library/Application Support/Adobe/CEP/extensions"
   ```
2. Copy this project folder into:
   ```text
   ~/Library/Application Support/Adobe/CEP/extensions/Veo-Bridge
   ```
3. Enable debug mode for CEP (recommended for CSXS 10/11):
   ```bash
   defaults write com.adobe.CSXS.10 PlayerDebugMode 1
   defaults write com.adobe.CSXS.11 PlayerDebugMode 1
   ```
4. Restart After Effects.

## Install on Windows

1. Copy this project folder into:
   ```text
   C:\Users\<YourUser>\AppData\Roaming\Adobe\CEP\extensions\Veo-Bridge
   ```
2. Enable debug mode for CEP (recommended for CSXS 10/11):
   ```bat
   reg add HKCU\Software\Adobe\CSXS.10 /v PlayerDebugMode /t REG_SZ /d 1 /f
   reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
   ```
3. Restart After Effects.

## Notes

- If your After Effects build uses a different CSXS runtime key, repeat `PlayerDebugMode` for that version (for example `CSXS.10`, `CSXS.11`, `CSXS.12`).
- Current scaffold includes two surfaces:
  - `Panel` -> `index.html`
  - `Gallery` (`Modeless`) -> `gallery.html`
- `index.html` is a launcher-only panel: `Capture`, `Open Gallery`, `Settings (API key)`.
- `gallery.html` is the main studio surface with a single unified feed + one floating composer panel.
- Composer flow:
  - choose `Image` or `Video`
  - for `Video`: choose `Frames` or `Ingredients`
  - configure aspect/sample/model in one options popover
- `Text-to-Video` is now part of `Video -> Frames` mode:
  - no Start/End -> text request
  - Start only -> image-to-video
  - Start+End -> interpolation
- Unified feed groups media by request batch:
  - `x4` request renders as one row with 4 media cards
  - row metadata is shown on the right
  - card actions (`Import/Reveal/Delete`) appear on hover
- Captured Frames are hidden by default and opened as overlay picker when selecting Start/End or adding refs.
- Asset picker overlay closes automatically after selecting a frame.
- Reference limits: Image refs up to `4`, Video refs up to `3`.
- Generation row states: `Idle`, `Generating`, `Done`, `Error`, `Missing file`.
- Gallery window open size is persisted in `userData/VeoBridge/settings.json` (`window.gallery.width`, `window.gallery.height`) and reused when opening from the main panel.
- Gallery generation controls now include `Aspect Ratio` (`16:9` or `9:16`), persisted in settings/local storage.
- Video generation default model: `veo-3.1-generate-preview` (`predictLongRunning` endpoint).
- Image generation default model: `gemini-3.1-flash-image-preview` (`generateContent` endpoint).
- Veo video request shape in this project is mode-specific (`bytesBase64Encoded` payloads):
  - `text`: `instances[].prompt`
  - `image` (Image-to-Video): `instances[].image.{bytesBase64Encoded,mimeType}`
  - `interpolation`: `instances[].image` + `instances[].lastFrame`
  - `reference`: `instances[].referenceImages[]` with `referenceType="asset"`
  - Non-text modes include `parameters.personGeneration=allow_adult`.
- Image request shape in this project: `contents[].parts` with `{text}` + optional reference `{inlineData}` and `generationConfig.responseModalities=["TEXT","IMAGE"]`.
- Video capability probe is available in `js/veoApi.js` (`probeVideoCapabilities`). Gallery uses it to detect image-input support and warn when non-text modes may fail for the current key/project.
- Capability probe performs two lightweight `predictLongRunning` upload checks (text + image-conditioned) and may consume minimal API quota.
- Model switch location: generation panel in Gallery (stored in `localStorage`).
- API request builders: `js/veoApi.js` (`generateVideo`, `generateImage`, model defaults/constants).
- Video generation now writes persistent `pendingJobs[]` into `state.json` and can resume unfinished jobs when Gallery is reopened (reusing saved `operationName/operationUrl` when available).
- Pending video resume uses a short-lived cross-window lease (`pendingJobsLease`) to avoid duplicate processing when multiple Gallery windows are open.
- Shared `state.json` stores `shots[]`, `pendingJobs[]`, `pendingJobsLease`, video settings (`videoGenSettings`), video refs (`videoRefs[]`), generated `videos[]`, generated `images[]`, `selectedImageId`, `imageGenSettings`, and `refs[]`.
- UI shows explicit status errors for common failures: missing frame/video files, unavailable state/CSInterface, API 401/403/429, network errors, and unexpected runtime exceptions.
- Selected video metadata is shown in compact summary form with optional expandable details.
- Generated videos/images are saved near the project by default (`<ProjectFolder>/VeoBridge/videos|images`) when project is saved; fallback is `userData/VeoBridge/videos|images`.

## Manual Testing Checklist

- [ ] Open panel `Veo Bridge` in After Effects and verify status is `Ready.`
- [ ] Click `Capture` with an active composition selected:
  - [ ] PNG is created under `VeoBridge/Frames`
  - [ ] Shot is appended to `state.json`
- [ ] Click `Settings` in the main panel:
  - [ ] Modal opens with API key input
  - [ ] Save stores key in `localStorage` and closes modal
- [ ] Click `Open Gallery`:
  - [ ] Gallery opens (extension dialog or `window.open` fallback)
  - [ ] Gallery window can be resized
  - [ ] Close and reopen Gallery: previous window size is restored (when opened via `window.open` path)
  - [ ] Captured Frames stay hidden until frame-picker overlay is opened from Start/End/Refs controls
- [ ] In captured frame picker overlay, verify visual markers:
  - [ ] Start frame shows `Start` badge overlay
  - [ ] End frame shows `End` badge overlay
  - [ ] If same shot is both Start and End, both badges are visible
- [ ] In unified composer select `Video` -> `Frames`:
  - [ ] Click Start and pick a frame from overlay
  - [ ] Click End and pick a frame from overlay
  - [ ] `startShotId` and `endShotId` are updated in `state.json`
  - [ ] Same frame can be used for both Start and End
- [ ] Verify Start/End cards show selected frame labels (`comp/file + frame`) and can be cleared/swapped.
- [ ] In unified composer (`Video` mode), enter prompt, choose model and `sampleCount=2`, click `Generate`:
  - [ ] Status stages show for each sample: `Uploading -> Polling -> Downloading`
  - [ ] During generation, controls are disabled (protection from double clicks)
  - [ ] Downloaded mp4 files are saved to `<ProjectFolder>/VeoBridge/videos` (or `userData` fallback)
  - [ ] Generated videos appear as stream rows with actions (`Import/Reveal/Delete`)
  - [ ] Pending/error/missing rows show explicit state chips
- [ ] Recovery check for unfinished video jobs:
  - [ ] Start video generation and close Gallery while sample is still running
  - [ ] Reopen Gallery and verify pending sample resumes automatically
  - [ ] When finished, generated video appears in the unified media feed without re-running manually
- [ ] In unified composer, verify video modes:
  - [ ] `Frames`: 
    - [ ] with empty Start + End -> Text-to-Video request
    - [ ] with Start only -> Image-to-Video request
    - [ ] with Start + End -> Interpolation request
  - [ ] `Ingredients`: requires 1..3 refs in Video Reference Images panel
  - [ ] If key/project does not support image inputs, hint warns that Frames/Reference may fail with API 400
- [ ] For generated video rows:
  - [ ] `Import` imports into `VeoBridge/Generated`
  - [ ] `Reveal` opens Finder/Explorer location
  - [ ] `Delete` removes record from `state.json` (and removes file when possible)
- [ ] In unified composer select `Image`, add prompt-only request and click `Generate`:
  - [ ] Status stages show `Uploading -> Generating -> Downloading -> Done`
  - [ ] Generated image appears as a stream row with row actions
- [ ] In unified composer (`Image`), add 1-4 reference images and run generation again:
  - [ ] References appear in 4-slot refs strip and are sent with prompt
  - [ ] Generation succeeds or returns readable API error
- [ ] For generated image rows:
  - [ ] `Import` imports into `VeoBridge/Generated`
  - [ ] `To Frames` creates a new shot in `shots[]`
  - [ ] `Reveal` opens Finder/Explorer location
  - [ ] `Delete` removes image from `state.json` (and removes file when possible)
- [ ] Restart AE / reopen panel and verify persistence:
  - [ ] `images[]` still visible in unified feed
  - [ ] shots added from image are still visible in frame-picker overlays
  - [ ] pending video jobs resume on reopen and continue updating rows
- [ ] Negative checks:
  - [ ] Empty prompt shows a clear validation error
  - [ ] Missing API key shows a clear validation error
  - [ ] End without Start shows a clear validation error
  - [ ] Invalid/missing reference file shows a clear validation error
  - [ ] HTTP/API failure shows status code and readable error text

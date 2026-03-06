## Install Guide

### macOS (`.pkg`)

1. Close After Effects.
2. Install the package:
```bash
open ~/Downloads/Veo-Bridge-0.1.0.pkg
```
3. If macOS blocks it (Gatekeeper):
```bash
xattr -dr com.apple.quarantine ~/Downloads/Veo-Bridge-0.1.0.pkg
open ~/Downloads/Veo-Bridge-0.1.0.pkg
```
4. Enable CEP debug mode:
```bash
defaults write com.adobe.CSXS.10 PlayerDebugMode 1
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```
5. Restart After Effects.

Verify installation:
```bash
ls -la "/Library/Application Support/Adobe/CEP/extensions/Veo-Bridge"
```

Uninstall:
```bash
sudo rm -rf "/Library/Application Support/Adobe/CEP/extensions/Veo-Bridge"
```

### Windows (`.msi`)

1. Close After Effects.
2. Install MSI (double-click), or via command:
```bat
msiexec /i "%USERPROFILE%\Downloads\Veo-Bridge-0.1.0.msi"
```
3. If SmartScreen blocks it: click `More info` -> `Run anyway`.
4. Enable CEP debug mode:
```bat
reg add HKCU\Software\Adobe\CSXS.10 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
```
5. Restart After Effects.

Verify installation:
```bat
explorer "%APPDATA%\Adobe\CEP\extensions\Veo-Bridge"
```

Uninstall:
```bat
msiexec /x "%USERPROFILE%\Downloads\Veo-Bridge-0.1.0.msi"
```

### Troubleshooting

1. Extension does not appear in AE:
```text
Check install path + PlayerDebugMode + fully restart AE.
```
2. On macOS, extension appears in AE but not in `~/Library/...`:
```text
.pkg installs to system path: /Library/Application Support/Adobe/CEP/extensions/Veo-Bridge
```
3. AE 2020 is supported, but some UI limitations may still exist due to CEP 10 behavior (known issue).

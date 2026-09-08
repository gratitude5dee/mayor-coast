# COAST Draw Messages extension

This target renders the `/draw` canvas inside Messages with `MSMessagesAppViewController` and PencilKit. The Vercel draw APIs remain the source of session authorization, generation state, and media.

1. Install full Xcode and XcodeGen.
2. Run `xcodegen generate` in this directory.
3. Open `CoastDraw.xcodeproj`, select the 5DEE Apple Developer team for both targets, and replace the two example bundle identifiers if necessary.
4. Install with Xcode or TestFlight.
5. Set Vercel `COAST_DRAW_APPLE_TEAM_ID` and `COAST_DRAW_EXTENSION_BUNDLE_ID` to the signed extension values. Set `COAST_DRAW_APP_STORE_ID` after an App Store Connect record exists.

Until the extension is installed, COAST sends Photon’s URL mini-app card. The same private draw session opens in Messages without putting its launch secret in preview metadata.

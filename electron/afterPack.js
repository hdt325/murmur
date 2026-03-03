/**
 * afterPack hook — ad-hoc sign the macOS app with entitlements.
 * electron-builder skips signing when no Developer ID cert is found.
 * This hook runs codesign manually so the app has a stable identity
 * and embedded entitlements (required for macOS mic permission persistence).
 */
const { execSync } = require("child_process");
const path = require("path");

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(__dirname, "entitlements.mac.plist");

  console.log(`[afterPack] Ad-hoc signing ${appPath} with entitlements`);

  try {
    execSync(
      `codesign --sign - --force --deep --entitlements "${entitlements}" "${appPath}"`,
      { stdio: "inherit" }
    );
    console.log("[afterPack] Signing complete");
  } catch (err) {
    console.error("[afterPack] Signing failed:", err.message);
  }
};

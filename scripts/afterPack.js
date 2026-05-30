'use strict';
/**
 * LOCRIUM afterPack hook — Windows PE metadata injection
 *
 * Called automatically by electron-builder after each platform pack step.
 * On Windows builds it uses `rcedit` (bundled with electron-builder) to embed
 * the extra version-string fields from build/version-info.json into the
 * compiled EXE so they appear in Windows Properties → Details.
 *
 * Fields written (in addition to what electron-builder sets natively from
 * package.json productName / version / copyright / author):
 *   FileDescription  — shown as "Description" in Windows Properties
 *   CompanyName      — shown as "Company" in Windows Properties
 *   LegalCopyright   — full copyright string
 *   LegalTrademarks  — trademark notice
 *   OriginalFilename — canonical filename embedded in EXE header
 *   InternalName     — internal product name
 *   Comments         — freeform comment string
 */

const path = require('path');
const fs   = require('fs');

module.exports = async function afterPack({ appOutDir, packager }) {
  // Only run on Windows builds
  if (packager.platform.name !== 'windows') return;

  const versionInfoPath = path.join(__dirname, '..', 'build', 'version-info.json');
  if (!fs.existsSync(versionInfoPath)) {
    console.warn('[afterPack] build/version-info.json not found — skipping PE metadata injection');
    return;
  }

  const versionInfo = JSON.parse(fs.readFileSync(versionInfoPath, 'utf8'));

  // Locate the main executable in the unpacked output directory.
  // electron-builder's executableName sets the EXE name.
  const execName = (packager.appInfo.productFilename || 'Locrium') + '.exe';
  const exePath  = path.join(appOutDir, execName);

  if (!fs.existsSync(exePath)) {
    console.warn(`[afterPack] Executable not found: ${exePath} — skipping PE metadata injection`);
    return;
  }

  // rcedit writes VERSIONINFO resources directly into a Windows PE executable.
  // It is declared as a direct devDependency (rcedit ^1.1.1).
  let rcedit;
  try {
    rcedit = require('rcedit');
  } catch (loadErr) {
    const msg = `[afterPack] rcedit is not installed — cannot inject PE metadata. Run "npm install" and retry. (${loadErr.message})`;
    // On Windows this is a hard requirement; fail the build.
    // On other OS the binary won't run anyway, so warn and continue.
    if (process.platform === 'win32') {
      throw new Error(msg);
    }
    console.warn(msg + ' (non-Windows host — skipping)');
    return;
  }

  const versionString = {};
  if (versionInfo.FileDescription)  versionString.FileDescription  = versionInfo.FileDescription;
  if (versionInfo.CompanyName)      versionString.CompanyName      = versionInfo.CompanyName;
  if (versionInfo.LegalCopyright)   versionString.LegalCopyright   = versionInfo.LegalCopyright;
  if (versionInfo.LegalTrademarks)  versionString.LegalTrademarks  = versionInfo.LegalTrademarks;
  if (versionInfo.OriginalFilename) versionString.OriginalFilename = versionInfo.OriginalFilename;
  if (versionInfo.InternalName)     versionString.InternalName     = versionInfo.InternalName;
  if (versionInfo.Comments)         versionString.Comments         = versionInfo.Comments;

  try {
    await rcedit(exePath, { 'version-string': versionString });
    console.log(`[afterPack] PE metadata injected into ${execName}`);
  } catch (err) {
    const msg = `[afterPack] rcedit failed to inject PE metadata into ${execName}: ${err.message}`;
    // On Windows, injection is a stated requirement — fail the build.
    if (process.platform === 'win32') {
      throw new Error(msg);
    }
    // On non-Windows hosts rcedit cannot execute the Windows binary — log only.
    console.error(msg + ' (non-Windows host)');
  }
};

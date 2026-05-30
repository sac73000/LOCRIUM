'use strict';
/**
 * LOCRIUM Version Bump Script
 *
 * Increments the version in package.json and prints the new version.
 * Optionally creates a git tag for the release.
 *
 * Usage:
 *   node scripts/version-bump.js patch    # 1.0.0 → 1.0.1
 *   node scripts/version-bump.js minor    # 1.0.0 → 1.1.0
 *   node scripts/version-bump.js major    # 1.0.0 → 2.0.0
 *
 * npm shortcuts (defined in package.json):
 *   npm run version:patch
 *   npm run version:minor
 *   npm run version:major
 *
 * Options:
 *   --no-tag   Skip creating a git tag (default: tag is created)
 *   --tag      Force create git tag (default behaviour)
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseVersion(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) throw new Error(`Invalid semver: "${v}"`);
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    pre:   m[4] || null,
  };
}

function formatVersion({ major, minor, patch, pre }) {
  const base = `${major}.${minor}.${patch}`;
  return pre ? `${base}-${pre}` : base;
}

function bumpVersion(current, part) {
  const v = parseVersion(current);
  switch (part) {
    case 'major': return formatVersion({ major: v.major + 1, minor: 0, patch: 0, pre: null });
    case 'minor': return formatVersion({ major: v.major, minor: v.minor + 1, patch: 0, pre: null });
    case 'patch': return formatVersion({ major: v.major, minor: v.minor, patch: v.patch + 1, pre: null });
    default: throw new Error(`Unknown bump type "${part}". Use: patch | minor | major`);
  }
}

function gitAvailable() {
  try { execSync('git --version', { stdio: 'pipe' }); return true; }
  catch (_) { return false; }
}

function gitTag(version) {
  const tag = `v${version}`;
  try {
    execSync(`git add package.json`, { stdio: 'pipe' });
    execSync(`git commit -m "chore: bump version to ${version}"`, { stdio: 'pipe' });
    execSync(`git tag -a ${tag} -m "Release ${tag}"`, { stdio: 'pipe' });
    console.log(`[version-bump] Created git commit and tag: ${tag}`);
  } catch (err) {
    console.warn(`[version-bump] git tag skipped: ${err.message.split('\n')[0]}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags   = process.argv.slice(2).filter((a) => a.startsWith('--'));
const part    = args[0];
const noTag   = flags.includes('--no-tag');

if (!part) {
  console.error('[version-bump] Usage: node scripts/version-bump.js <patch|minor|major> [--no-tag]');
  process.exit(1);
}

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const oldVersion = pkg.version;
const newVersion = bumpVersion(oldVersion, part);

pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

console.log(`[version-bump] ${oldVersion} → ${newVersion}`);

if (!noTag && gitAvailable()) {
  gitTag(newVersion);
} else if (!noTag) {
  console.log('[version-bump] git not available — skipping tag (version written to package.json)');
}

console.log(`[version-bump] Done. Next: npm run build:release`);

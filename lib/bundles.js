/**
 * Where a bundle actually lives - asked the way the Host asks it.
 *
 * Why this module exists (2026-11-22 incident)
 * -------------------------------------------
 * `repair.js` decided "this bundle cannot be resolved" by looking at exactly one place:
 * `<profile>/node_modules/<name>/package.json`. That is not how the Host resolves a bundle.
 * `@deepseek-ai/dsh-app-boot` tries **two anchors in order** -
 *
 *   1. the installation anchor (`<resources>/app.asar/dsh/package.json`), then
 *   2. the profile's own `package.json` -
 *
 * and only when both miss does it call the bundle unresolvable. Every in-box bundle
 * (`@deepseek-ai/dsh-base`, `dsh-web-app`, the four `dsh-experimental-*`) ships inside the
 * installation and is **never** present in a profile's `node_modules`. A one-anchor check
 * therefore called five working bundles unresolvable, and the repair engine offered to delete
 * them from `dsh.profile.bundles` - a change that removes the UI shell from a perfectly healthy
 * install. The same false positive had already been printed by the post-update report on
 * 2026-11-21 04:17.
 *
 * The second half of the trap
 * ---------------------------
 * `app.asar` is an **archive**, not a directory. The Host runs inside Electron, whose `fs`
 * virtualises it, so `existsSync('<resources>/app.asar/dsh/package.json')` is `true` there. The
 * standalone CLI is a plain Node program: the same path is a 200 MB file, `existsSync` answers
 * `false`, and Node's module resolution cannot see inside it at all. Fixing the anchor order
 * alone would therefore still have produced the false alarm in exactly the situation the rescue
 * tool exists for - DSH is down, the user runs the CLI. So this module reads the asar header
 * itself (`asarPack` layout: 16-byte prefix, JSON index, offsets) and answers "does this package
 * exist inside the archive" without Electron.
 *
 * The safety rule that makes a wrong answer harmless
 * -------------------------------------------------
 * Absence is a **claim**, and this module only makes it when it could actually look: with no
 * usable installation anchor (or an unreadable archive) a bundle is reported as `unknown`, never
 * as `missing`. And even a proven absence of an `@deepseek-ai/*` bundle is reported separately
 * and is never auto-removed - deleting an official bundle removes the UI shell, which is far
 * worse than the error it was meant to fix.
 *
 * @module dsh-rescue-guard/bundles
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { isValidPackageName } from './scan.js'

/** A package.json is a few kilobytes; anything far larger is a broken install, not data. */
const MAX_JSON_BYTES = 1024 * 1024
/** An asar index is a few MB in practice (5.6 MB on the reference install); cap it anyway. */
const MAX_ASAR_HEADER_BYTES = 256 * 1024 * 1024

/** Recorded by the Host half, read by the CLI: where the running installation lives. */
export const HOST_RECORD = 'host.json'

/** `<profile>/.rescue` without importing paths.js (keeps this module dependency-light). */
function rescuePath(profileDir, name) {
  return path.join(profileDir, '.rescue', name)
}

/**
 * A profile directory as an absolute path.
 *
 * `createRequire` rejects a relative anchor outright, and swallowing that rejection turned a
 * merely *relative* input into a confident "this bundle is missing" — the same class of mistake
 * this module exists to remove. Normalising at every entry point means the answer can only be
 * "found" or "not found after actually looking".
 *
 * @param {string} profileDir - Possibly relative profile directory.
 * @returns {string} Absolute path, or '' when the input is unusable.
 */
function absoluteProfile(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return ''
  return path.resolve(profileDir)
}

function readJsonSafe(file) {
  try {
    if (statSync(file).size > MAX_JSON_BYTES) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ asar */

/** Parsed archive indexes, keyed by absolute path. An asar never changes while it is open. */
const asarIndexCache = new Map()

/**
 * Read an asar archive's file index.
 *
 * Layout (Chromium's `asarPack`): `uint32` 4 = header-size field size, `uint32` header-size,
 * `uint32` header-string size, `uint32` JSON length, then the JSON index. Only the last two are
 * needed here, and reading them is what makes the archive readable without Electron.
 *
 * @param {string} asarFile - Absolute path of the `.asar` file.
 * @returns {{ files: object }|null} The index root, or null when it is not a readable archive.
 */
export function readAsarIndex(asarFile) {
  if (typeof asarFile !== 'string' || asarFile === '') return null
  const cached = asarIndexCache.get(asarFile)
  if (cached !== undefined) return cached
  let fd = -1
  let index = null
  try {
    const stat = statSync(asarFile)
    if (!stat.isFile()) {
      /* Electron virtualises the archive as a *directory*: the real files are already visible
       * through normal fs calls, so there is nothing to parse. */
      asarIndexCache.set(asarFile, null)
      return null
    }
    fd = openSync(asarFile, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonSize = head.readUInt32LE(12)
    if (!Number.isInteger(jsonSize) || jsonSize <= 0 || jsonSize > MAX_ASAR_HEADER_BYTES) {
      asarIndexCache.set(asarFile, null)
      return null
    }
    const json = Buffer.alloc(jsonSize)
    readSync(fd, json, 0, jsonSize, 16)
    const parsed = JSON.parse(json.toString('utf8'))
    index = parsed && typeof parsed === 'object' && parsed.files ? parsed : null
  } catch {
    index = null
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd)
      } catch {
        /* closing a probe handle is not worth an error */
      }
    }
  }
  asarIndexCache.set(asarFile, index)
  return index
}

/** Walk `parts` inside a parsed asar index. @returns the node, or undefined. */
function asarNode(index, parts) {
  let node = index
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !node.files) return undefined
    node = node.files[part]
    if (node === undefined) return undefined
  }
  return node
}

/** Does a directory exist inside the archive? */
function asarDirExists(asarFile, parts) {
  const index = readAsarIndex(asarFile)
  if (index === null) return false
  const node = asarNode(index, parts)
  return Boolean(node && typeof node === 'object' && node.files)
}

/** Does `<parts>/package.json` exist inside the archive? */
function asarPackageExists(asarFile, parts) {
  const index = readAsarIndex(asarFile)
  if (index === null) return false
  /* A file entry has no `files` map, so this must not go through asarDirExists: the answer here
   * is "the node exists", whatever kind of node it is. */
  return asarNode(index, [...parts, 'package.json']) !== undefined
}

/* ------------------------------------------------------------------ anchors */

/**
 * The installation's `package.json` - the Host's first resolution anchor.
 *
 * Every candidate is verified before it is used, and each one may describe either a real
 * directory (Electron virtualised, or an unpacked install) or an asar archive (plain Node). A
 * stale record left behind by an older install can therefore never turn into a wrong
 * "this bundle is missing": it is simply dropped.
 *
 * Order is most authoritative first:
 *  - `process.resourcesPath`: set by the Desktop shell, i.e. the running installation itself;
 *  - an explicit `hostModules` (index.js resolves it once and passes it down);
 *  - a previously recorded `.rescue/host.json` - the only source the standalone CLI has;
 *  - the environment variables the shell *may* set (speculative, verified anyway);
 *  - a Desktop build run from its own directory (`<exe dir>/resources`).
 *
 * @param {{ profileDir?: string, hostModules?: string|null, env?: object, resourcesPath?: string|null }} [opts]
 * @returns {{ kind: 'dir'|'asar', anchor: string, inner: string[], asar?: string, source: string }[]}
 */
export function installationAnchors({ profileDir = '', hostModules = null, env = process.env, resourcesPath = null } = {}) {
  const found = []
  const seen = new Set()

  /** Turn a resources directory into an anchor descriptor, or null when it is not one. */
  const fromResources = (resources, source) => {
    if (typeof resources !== 'string' || resources === '') return null
    const asarFile = path.join(resources, 'app.asar')
    const innerFile = path.join(asarFile, 'dsh', 'package.json')
    /* Electron: the archive is a directory and normal fs calls see through it. */
    if (existsSync(innerFile)) return { kind: 'dir', anchor: innerFile, inner: [], source }
    /* Plain Node: read the archive index instead. */
    if (existsSync(asarFile)) return { kind: 'asar', asar: asarFile, anchor: asarFile, inner: ['dsh'], source }
    return null
  }

  const add = (entry) => {
    if (entry === null) return
    const key = entry.kind + '\u0000' + entry.anchor + '\u0000' + entry.inner.join('/')
    if (seen.has(key)) return
    seen.add(key)
    found.push(entry)
  }

  const live = typeof resourcesPath === 'string' && resourcesPath !== '' ? resourcesPath : process.resourcesPath
  add(fromResources(live, 'process.resourcesPath'))

  if (typeof hostModules === 'string' && hostModules !== '') {
    const anchorFile = path.join(hostModules, '..', 'package.json')
    if (existsSync(anchorFile)) add({ kind: 'dir', anchor: anchorFile, inner: [], source: 'hostModules' })
  }

  const recorded = readJsonSafe(rescuePath(absoluteProfile(profileDir) || '.', HOST_RECORD))
  add(fromResources(recorded?.resourcesPath, 'recorded:host.json'))
  if (typeof recorded?.hostModules === 'string' && recorded.hostModules !== '') {
    const anchorFile = path.join(recorded.hostModules, '..', 'package.json')
    if (existsSync(anchorFile)) add({ kind: 'dir', anchor: anchorFile, inner: [], source: 'recorded:host.json' })
  }

  add(fromResources(env?.DSH_RESOURCES_PATH, 'env:DSH_RESOURCES_PATH'))
  add(
    fromResources(
      env?.PORTABLE_EXECUTABLE_DIR ? path.join(env.PORTABLE_EXECUTABLE_DIR, 'resources') : null,
      'env:PORTABLE_EXECUTABLE_DIR'
    )
  )

  const execDir = path.dirname(process.execPath || '')
  if (execDir && execDir !== '.') add(fromResources(path.join(execDir, 'resources'), 'execPath'))

  return found
}

/**
 * Remember where the running installation lives, so the standalone CLI (which has no
 * `process.resourcesPath` and no Electron) resolves the same way the Host does.
 *
 * Best effort by construction: a rescue plugin that throws while recording its own anchor would
 * be the crash it exists to clean up after.
 *
 * @param {string} profileDir - Profile directory.
 * @param {{ resourcesPath?: string|null, hostModules?: string|null }} info
 * @returns {boolean} whether the record was written.
 */
export function recordHostAnchor(profileDir, { resourcesPath = null, hostModules = null } = {}) {
  if (typeof profileDir !== 'string' || profileDir === '') return false
  if (typeof resourcesPath !== 'string' && typeof hostModules !== 'string') return false
  try {
    const dir = path.join(profileDir, '.rescue')
    if (!existsSync(dir)) return false
    const payload = {
      at: new Date().toISOString(),
      resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : null,
      hostModules: typeof hostModules === 'string' ? hostModules : null,
      /* Whether the archive had to be read as a file (plain Node) or was already visible. */
      asarMode: typeof resourcesPath === 'string' && existsSync(path.join(resourcesPath, 'app.asar', 'dsh', 'package.json'))
        ? 'virtual'
        : 'archive',
    }
    /* Plain write: this is a hint for a later process, not a manifest whose partial state could
     * corrupt a boot. A truncated json is simply ignored by readJsonSafe. */
    writeFileSync(path.join(dir, HOST_RECORD), JSON.stringify(payload, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ resolution */

/**
 * The package directory reachable from one *directory* anchor, or null.
 *
 * Identical in behaviour to the Host's `packageDirFromAnchor`: Node's own `node_modules` lookup
 * order from that anchor, probing for a `package.json` (so a package that does not export
 * `./package.json` still resolves, and symlinked / hoisted layouts are followed).
 *
 * @param {string} anchor - Absolute path of a `package.json` to resolve from.
 * @param {string} name - Package name (already validated).
 * @returns {string|null} Absolute package directory.
 */
export function packageDirFromAnchor(anchor, name) {
  let searchPaths = []
  try {
    searchPaths = createRequire(anchor).resolve.paths(name) ?? []
  } catch {
    return null
  }
  for (const searchPath of searchPaths) {
    const candidate = path.join(searchPath, ...name.split('/'))
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  return null
}

/** The same lookup inside an asar archive, expressed as virtual paths. */
function packageDirInAsar(asarFile, inner, name) {
  const segments = String(name).split('/')
  /* Node walks up the `node_modules` chain from the anchor: <inner>/node_modules, then
   * <inner minus one>/node_modules, ... and finally <asar root>/node_modules. */
  for (let depth = inner.length; depth >= 0; depth -= 1) {
    const parts = [...inner.slice(0, depth), 'node_modules', ...segments]
    if (asarPackageExists(asarFile, parts)) return path.join(asarFile, ...parts)
  }
  return null
}

/**
 * Resolve `name` from one anchor descriptor.
 * @returns {{ dir: string, anchor: string, source: string }|null}
 */
function resolveFromAnchor(entry, name) {
  if (entry.kind === 'dir') {
    const dir = packageDirFromAnchor(entry.anchor, name)
    return dir === null ? null : { dir, anchor: entry.anchor, source: entry.source }
  }
  if (entry.kind === 'asar') {
    const dir = packageDirInAsar(entry.asar, entry.inner, name)
    if (dir !== null) return { dir, anchor: entry.anchor, source: entry.source }
    /* An unpacked install keeps some files beside the archive. */
    const unpacked = entry.asar + '.unpacked'
    if (existsSync(unpacked)) {
      for (let depth = entry.inner.length; depth >= 0; depth -= 1) {
        const parts = [...entry.inner.slice(0, depth), 'node_modules', ...String(name).split('/')]
        const candidate = path.join(unpacked, ...parts)
        if (existsSync(path.join(candidate, 'package.json'))) {
          return { dir: candidate, anchor: entry.anchor, source: entry.source + '(unpacked)' }
        }
      }
    }
    return null
  }
  return null
}

/** Bundle names declared in `dsh.profile.bundles`, tolerating `{ name }` entries. */
export function declaredBundles(profileDir) {
  const pkg = readJsonSafe(path.join(absoluteProfile(profileDir) || '.', 'package.json'))
  const raw = pkg?.dsh?.profile?.bundles
  if (!Array.isArray(raw)) return []
  const names = []
  for (const item of raw) {
    if (typeof item === 'string' && item) names.push(item)
    else if (item && typeof item === 'object' && typeof item.name === 'string' && item.name) names.push(item.name)
  }
  return names
}

/**
 * Resolve one bundle the way the Host does: installation anchor first, profile second.
 *
 * @param {string} profileDir - Profile directory.
 * @param {string} name - Bundle package name.
 * @param {{ hostModules?: string|null, env?: object, resourcesPath?: string|null, anchors?: object[] }} [opts]
 * @returns {{ name: string, dir: string|null, source: 'host'|'profile'|'invalid'|'missing', anchor: string|null }}
 */
export function resolveBundle(profileDir, name, opts = {}) {
  if (!isValidPackageName(name)) return { name, dir: null, source: 'invalid', anchor: null }
  const profile = absoluteProfile(profileDir)
  const anchors = Array.isArray(opts.anchors) ? opts.anchors : installationAnchors({ profileDir: profile, ...opts })
  for (const entry of anchors) {
    const hit = resolveFromAnchor(entry, name)
    if (hit !== null) return { name, dir: hit.dir, source: 'host', anchor: hit.source }
  }
  const profileAnchor = profile === '' ? '' : path.join(profile, 'package.json')
  if (profileAnchor !== '' && existsSync(profileAnchor) && isAbsoluteAnchor(profileAnchor)) {
    const dir = packageDirFromAnchor(profileAnchor, name)
    if (dir !== null) return { name, dir, source: 'profile', anchor: 'profile' }
  }
  /* No profile anchor at all is not proof of absence either: the caller handed us a directory
   * that does not hold a package.json, so nothing was searched. */
  if (profileAnchor === '' || !existsSync(profileAnchor)) {
    return { name, dir: null, source: 'unsearchable', anchor: null }
  }
  return { name, dir: null, source: 'missing', anchor: null }
}

/** `createRequire` needs an absolute path; anything else cannot anchor a search. */
function isAbsoluteAnchor(anchor) {
  return typeof anchor === 'string' && anchor !== '' && path.isAbsolute(anchor)
}

/**
 * Classify every declared bundle into the four states a safe repair needs.
 *
 *  - `resolved` - found, and `source` says which anchor found it (host or profile);
 *  - `missing` - **proven** absent from every anchor that could be inspected;
 *  - `unknown` - absent, but no installation anchor could be inspected, so "it is gone" is not
 *    something this tool is allowed to claim;
 *  - `invalid` - not a legal package name; reported, never edited.
 *
 * A resolved bundle is reported with `anchor` = which anchor found it. An absence is only called
 * `unknown` for a **first-party** name: an `@deepseek-ai/*` bundle ships inside the installation,
 * so without a readable installation its absence proves nothing. A third-party bundle is never
 * shipped with DSH - the profile is its only possible home - so its absence from the profile is
 * proof on its own, and that is what keeps the repair useful on a machine where the app itself
 * cannot be found.
 *
 * @param {string} profileDir - Profile directory.
 * @param {{ hostModules?: string|null, env?: object, resourcesPath?: string|null }} [opts]
 */
export function inspectBundles(profileDir, opts = {}) {
  const profile = absoluteProfile(profileDir)
  const anchors = installationAnchors({ profileDir: profile, ...opts })
  const names = declaredBundles(profile)
  const resolved = []
  const missing = []
  const unknown = []
  const invalid = []
  const rows = []
  for (const name of names) {
    const hit = resolveBundle(profile, name, { ...opts, anchors })
    rows.push(hit)
    if (hit.source === 'invalid') invalid.push(name)
    else if (hit.source !== 'missing' && hit.source !== 'unsearchable') {
      resolved.push({ name, dir: hit.dir, source: hit.source, anchor: hit.anchor })
    } else if (hit.source === 'unsearchable') unknown.push(name)
    else if (anchors.length === 0 && name.startsWith('@deepseek-ai/')) unknown.push(name)
    else missing.push(name)
  }
  return {
    /** Which installation anchors were actually usable for this inspection. */
    anchors: anchors.map((entry) => ({ kind: entry.kind, anchor: entry.anchor, source: entry.source })),
    /** Whether an absence can be proven on this machine. */
    provable: anchors.length > 0,
    rows,
    resolved,
    missing,
    unknown,
    invalid,
    /** Official in-box bundles that are absent: never auto-removed, always reported. */
    officialMissing: missing.filter((name) => name.startsWith('@deepseek-ai/')),
    /** Third-party bundles proven absent: the only names a repair may touch. */
    removable: missing.filter((name) => !name.startsWith('@deepseek-ai/')),
  }
}

/* ------------------------------------------------------------------ host discovery */

/**
 * The running installation's `node_modules`, or null.
 *
 * Only the Desktop shell knows where it lives (`process.resourcesPath`), and only when this code
 * runs inside the app. Returning null is correct for a plain `dsh web`; callers then fall back to
 * the recorded anchor instead of inventing a path.
 *
 * @returns {string|null}
 */
export function resolveHostModules() {
  try {
    const resources = process.resourcesPath
    if (typeof resources !== 'string' || !resources) return null
    const candidate = path.join(resources, 'app.asar', 'dsh', 'node_modules')
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

/**
 * The installation's package.json anchor, or null.
 * @returns {string|null}
 */
export function resolveInstallAnchor() {
  const hostModules = resolveHostModules()
  if (hostModules === null) return null
  const candidate = path.join(hostModules, '..', 'package.json')
  return existsSync(candidate) ? candidate : null
}

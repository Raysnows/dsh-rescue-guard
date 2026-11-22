#!/usr/bin/env node
/**
 * Put a double-clickable rescue console on the desktop.
 *
 * Why this exists: when DSH refuses to start, the GUI is the thing that is broken, so the only
 * affordance left is "double-click something on the desktop". A .cmd in the plugin's
 * `node_modules` path is unusable in that moment — the user has to know where npm put it.
 *
 * This writes ONE file and nothing else: `<Desktop>\DSH救援台.cmd`. No registry, no scheduled
 * task, no autostart. Content comes from `desktopEntryLines()` — the single source shared with
 * the settings button and the install popup — so node never runs a .cmd
 * (ERR_UNKNOWN_FILE_EXTENSION, 2026-11-11).
 *
 * `node bin/install-desktop.mjs [--shortcut | --remove]`
 *
 * `--shortcut` creates `DSH救援台.lnk` instead of the `.cmd` — a batch file cannot carry a
 * custom icon, and this entry is meant to look like the plugin on the desktop.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cliFile = path.join(here, 'dsh-rescue.mjs')
const consoleFile = path.join(here, 'rescue-console.cmd')
const iconFile = path.join(here, '..', 'assets', 'dsh-rescue.ico')
const ENTRY_NAME = 'DSH救援台.cmd'
const SHORTCUT_NAME = 'DSH救援台.lnk'

/** Desktop directory: OneDrive redirects it, so a fixed `~` path is wrong on many machines. */
function desktopDir(env = process.env) {
  if (process.platform === 'win32') {
    const home = env.USERPROFILE || os.homedir()
    const candidates = [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, '桌面')]
    for (const dir of candidates) if (existsSync(dir)) return dir
    return candidates[0]
  }
  const home = env.HOME || os.homedir()
  return path.join(home, 'Desktop')
}

const remove = process.argv.includes('--remove')
const shortcut = process.argv.includes('--shortcut')
const desktop = desktopDir()
const target = path.join(desktop, process.platform === 'win32' ? ENTRY_NAME : 'dsh-rescue-console.sh')
const linkTarget = path.join(desktop, SHORTCUT_NAME)

if (remove) {
  rmSync(target, { force: true })
  console.log('已移除：' + target)
  if (process.platform === 'win32' && existsSync(linkTarget)) {
    rmSync(linkTarget, { force: true })
    console.log('已移除：' + linkTarget)
  }
  process.exit(0)
}

/** PowerShell single-quoted literal: only ' needs doubling. */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * Create a real .lnk so the desktop entry can carry the plugin's own icon.
 *
 * A .cmd cannot: the Windows shell always draws cmd.exe's icon for batch files, whatever the
 * file contains. Only a shortcut has a settable `IconLocation`.
 *
 * The link targets the pure-ASCII console in bin/ (it self-locates and pauses on double-click),
 * never node.exe directly — a flash-and-close window is useless when DSH cannot start.
 *
 * @returns true when the shortcut file exists afterwards.
 */
function createShortcut(linkFile, targetCmd, workDir, icon) {
  if (!existsSync(targetCmd)) return false
  const statements = [
    "$ErrorActionPreference = 'Stop'",
    '$shell = New-Object -ComObject WScript.Shell',
    '$link = $shell.CreateShortcut(' + psQuote(linkFile) + ')',
    '$link.TargetPath = ' + psQuote(targetCmd),
    '$link.WorkingDirectory = ' + psQuote(workDir),
    '$link.Description = ' + psQuote('DSH rescue console'),
    ...(icon ? ['$link.IconLocation = ' + psQuote(icon + ',0')] : []),
    '$link.WindowStyle = 1',
    '$link.Save()',
  ].join('; ')
  try {
    // -EncodedCommand keeps the Chinese entry name intact: -Command goes through the console
    // code page, where UTF-8 arguments arrive mangled on this machine (2026-11-22).
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      Buffer.from(statements, 'utf16le').toString('base64'),
    ], { windowsHide: true, timeout: 45_000 })
  } catch {
    return false
  }
  return existsSync(linkFile)
}

/** Write a file, turning a permission failure into advice instead of a stack trace. */
function writeLauncher(target, content, exec = false) {
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
    if (exec) chmodSync(target, 0o755)
    return true
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      console.error('无权写入桌面目录：' + target)
      console.error('在普通 cmd（非管理员、非 DSH 会话）里重跑本命令即可。')
      return false
    }
    throw error
  }
}

if (process.platform === 'win32') {
  const { desktopEntryLines } = await import('../lib/desktop-offer.js')
  const entryBody = () => desktopEntryLines(cliFile).join('\r\n')

  if (shortcut) {
    const icon = existsSync(iconFile) ? iconFile : ''
    if (createShortcut(linkTarget, consoleFile, here, icon)) {
      console.log('已创建：' + linkTarget + '（带图标的桌面快捷方式）')
      if (!icon) console.warn('提示：未找到 assets/dsh-rescue.ico，快捷方式用的是默认图标。')
    } else {
      console.warn('创建快捷方式失败（PowerShell / WScript.Shell 不可用），改用 .cmd 入口。')
      if (writeLauncher(target, entryBody())) console.log('已创建：' + target + '（双击即开救援台）')
      else process.exitCode = 3
    }
  } else {
    const ok = writeLauncher(target, entryBody())
    if (ok) console.log('已创建：' + target + '（双击即开救援台）')
    else process.exitCode = 3
  }
} else {
  const body = [
    '#!/bin/sh',
    '# Generated by dsh-rescue-guard. Delete it and nothing else changes.',
    `exec node "${cliFile}" "$@"`,
    '',
  ].join('\n')
  if (writeLauncher(target, body, true)) console.log('已创建桌面入口：' + target)
  else process.exitCode = 3
}

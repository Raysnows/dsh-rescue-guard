#!/usr/bin/env node
/**
 * Pre-update check (2026-11-11 request):
 * "每次进行更新 DSH 版本的时候，这个东西应该先检测一下，而不是说让他更新之后出错。"
 *
 * A plugin cannot intercept the Desktop installer, so the honest implementation is:
 *   - a preflight the user runs BEFORE updating: profile health, every bundle resolvable,
 *     command clashes, missing files, cookie-header pressure → verdict okToUpdate;
 *   - a first-boot-after-version-change health report (.rescue/post-update.txt), because the
 *     fingerprint diff already knows the host version moved.
 *
 * PID-free, read-only except the report file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { inspectBundles } from './bundles.js'
import { BUILTIN_PRESETS, readPresetPointer } from './preset.js'

/**
 * Collect preflight findings.
 *
 * @param {{ profileDir: string, home: string, scan: Function, boot: object|null, fingerprint?: object|null, hostModules?: string|null }} deps
 * @returns {{ okToUpdate: boolean, findings: Array<{ level: string, text: string }>, scanned: object }}
 */
export function preflight({ profileDir, home, scan, boot = null, fingerprint = null, hostModules = null } = {}) {
  const findings = []
  const push = (level, text) => findings.push({ level, text })

  // 1) A previous boot that never finished is the strongest signal: do not update on top of it.
  if (boot && boot.pending === true) {
    push('block', `上次启动没有完成（${boot.lastFailedAt ?? boot.at ?? '时间未知'}）；先修好再升级。`)
  }

  // 2) The pre-flight static scan: command clashes, missing files, route shadows.
  let scanned = null
  try {
    scanned = scan({ profileDir, home })
    for (const clash of scanned.commands ?? []) {
      if (clash.owners && clash.owners.length > 1) {
        push('warn', `命令冲突 /${clash.name}：${clash.owners.join(' 与 ')}`)
      }
    }
    for (const missing of scanned.missingFiles ?? []) {
      push('warn', `缺文件：${missing.plugin} 读取 ${missing.path}`)
    }
    for (const shadow of scanned.routeShadows ?? []) {
      push('warn', `路由遮蔽：${shadow.plugin} 注册了 ${shadow.path}`)
    }
  } catch (error) {
    push('warn', `预检扫描失败：${error?.message ?? error}`)
  }

  /* 3) Bundle resolution — asked the way the Host asks it.
   *
   * The Host (@deepseek-ai/dsh-app-boot) resolves a bundle from the *installation* anchor first
   * and the profile second; every @deepseek-ai/* bundle ships inside the installation and is
   * never present in a profile's node_modules. Checking only the profile produced the
   * 2026-11-21/22 false alarm "bundle 解析不到: @deepseek-ai/dsh-base ..." on a healthy install,
   * and the repair engine then offered to delete those bundles outright. Only a *proven* third-
   * party absence is a finding now; an unprovable one is stated as unprovable. */
  try {
    const state = inspectBundles(profileDir, hostModules === null ? {} : { hostModules })
    for (const name of state.removable) {
      push('warn', `bundle 解析不到：${name}（安装目录与 profile 里都没有，升级后可能直接起不来）`)
    }
    for (const name of state.officialMissing) {
      push(
        'warn',
        `官方 bundle 解析不到：${name}（它应随宿主安装；先确认安装目录完好，本工具不会自动移除它）`
      )
    }
    for (const name of state.unknown) {
      push(
        'info',
        `无法确认 ${name} 是否存在：没找到宿主安装目录，不能证明它真的缺失（不自动处理）`
      )
    }
    if (!state.provable && state.unknown.length === 0 && state.resolved.length > 0) {
      push('info', '没有找到宿主安装目录：bundle 解析只能按 profile 判定，官方包一律视为随宿主安装')
    }
  } catch (error) {
    push('warn', `读不到 profile package.json：${error?.message ?? error}`)
  }

  // 4a) Preset pointer. The built-in four always exist; anything else is registered by a plugin
  // at runtime, so disabling that plugin leaves every session unopenable with no crash at all
  // (2026-11-15: dsh-ops off → `selectedDefault: ops-ptc` → agent-preset/not-found).
  try {
    const pointer = readPresetPointer(profileDir)
    const effective = pointer.effective
    if (typeof effective === 'string' && effective !== '' && !BUILTIN_PRESETS.includes(effective)) {
      push(
        'warn',
        `默认预设 ${effective} 不是内置预设（${BUILTIN_PRESETS.join(' / ')}）：它由某个插件在运行时注册，` +
          `禁用或卸载那个插件后，新会话会报 agent-preset/not-found、老会话 resume 失败（没有任何崩溃日志）。` +
          `升级前先确认该插件仍然启用；想改回内置预设：dsh-rescue preset --fix`
      )
    }
  } catch (error) {
    push('warn', `读预设指针失败：${error?.message ?? error}`)
  }

  // 4) Host version movement since the last good boot — the thing an update changes.
  try {
    const lastGood = boot?.lastGood ?? null
    const was = lastGood?.fingerprint?.hostVersion ?? lastGood?.hostVersion ?? null
    const now = fingerprint?.hostVersion ?? boot?.hostVersion ?? null
    if (was && now && was !== now) {
      push('info', `宿主版本 ${was} → ${now}：升级后首次启动会自动体检。`)
    }
  } catch {
    /* informational only */
  }

  const blocking = findings.filter((f) => f.level === 'block').length
  return { okToUpdate: blocking === 0, findings, scanned }
}

/**
 * Write the first-boot-after-an-update report.
 *
 * @returns {string|null} Report path, or null when there is nothing to report.
 */
export function writePostUpdateReport(profileDir, { previousVersion, currentVersion, findings, diffLines = [] } = {}) {
  if (!currentVersion) return null
  if (!previousVersion || previousVersion === currentVersion) return null
  try {
    const dir = path.join(profileDir, '.rescue')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'post-update.txt')
    const lines = [
      '=== DSH 升级后体检报告 ===',
      `时间：${new Date().toISOString()}`,
      `宿主版本：${previousVersion} → ${currentVersion}`,
      '',
      ...(diffLines.length ? ['指纹变化：', ...diffLines.map((l) => '  ' + l), ''] : []),
      '检查项：',
      ...(findings.length ? findings.map((f) => `  [${f.level}] ${f.text}`) : ['  （无阻断项）']),
      '',
      '完整检查可在 设置 → 启动救援 → 更新前检查 里随时重跑。',
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    return file
  } catch {
    return null
  }
}

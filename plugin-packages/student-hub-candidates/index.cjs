'use strict'

/* eslint-disable @typescript-eslint/no-require-imports */
const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')

const runFile = promisify(execFile)
const DEFAULT_ROOT = 'D:\\student-hub'
const DEFAULT_PYTHON = 'C:\\Users\\86130\\anaconda3.0\\python.exe'
// The loader fingerprint covers manifest.json + index.cjs; pin the Python helper too.
const HELPER_SHA256 = 'df4e15542095f12dce69edb47b333c8da67bba391eef48abf5eef9ec8a600e97'

function studentHubRoot() {
  return process.env.LCA_STUDENT_HUB_ROOT || DEFAULT_ROOT
}

function pythonPath() {
  if (process.env.LCA_STUDENT_HUB_PYTHON) return process.env.LCA_STUDENT_HUB_PYTHON
  return existsSync(DEFAULT_PYTHON) ? DEFAULT_PYTHON : 'python'
}

function configPath(root) {
  return process.env.LCA_STUDENT_HUB_CONFIG || path.join(root, 'config', 'sources.toml')
}

function childEnvironment(root) {
  const env = {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    USERPROFILE: process.env.USERPROFILE || '',
    TEMP: process.env.TEMP || '',
    TMP: process.env.TMP || '',
    PYTHONPATH: path.join(root, 'src'),
    PYTHONDONTWRITEBYTECODE: '1',
  }
  return env
}

function stripControls(value) {
  return [...String(value ?? '')].map((char) => {
    const code = char.charCodeAt(0)
    return code <= 31 || code === 127 ? ' ' : char
  }).join('')
}

function cleanLabel(value) {
  return stripControls(value).replace(/\s+/g, ' ').trim()
}

function truncate(value, limit) {
  return [...value].slice(0, limit).join('')
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text + 'T23:59:59+08:00'
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    const normalized = text.replace(' ', 'T')
    return normalized.length === 16 ? normalized + ':00+08:00' : normalized + '+08:00'
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function excerptFor(item) {
  const rawSubject = cleanLabel(item.artifact_subject)
  // Student Hub can keep evidence encrypted; never show its opaque envelope as a subject.
  const subject = rawSubject.startsWith('shenc:') || rawSubject.startsWith('enc:') ? '' : rawSubject
  const course = cleanLabel(item.course)
  const summary = cleanLabel(item.source_summary)
  const preview = stripControls(item.artifact_preview).trim().slice(0, 6000)
  const date = cleanLabel(item.deadline_at || item.event_start)
  return [
    subject ? '主题：' + subject : '',
    course ? '课程：' + course : '',
    date ? '日期：' + date : '',
    summary ? '摘要：' + summary : '',
    preview ? '原文预览：\n' + preview : '',
  ].filter(Boolean).join('\n').slice(0, 8000)
}

function toSeed(item, nowMs) {
  const deadline = toIso(item.deadline_at)
  const eventStart = toIso(item.event_start)
  const eventEnd = toIso(item.event_end)
  const isEvent = item.item_type === 'event' && Boolean(eventStart)
  const anchor = isEvent ? eventStart : deadline
  const anchorMs = anchor ? Date.parse(anchor) : Number.NaN
  // A card without a future-ish date is not an actionable schedule candidate.
  if (!Number.isFinite(anchorMs) || anchorMs < nowMs - 24 * 60 * 60 * 1000) return null
  const title = truncate(cleanLabel(item.title) || cleanLabel(item.artifact_subject) || '校园事项', 20)
  const course = cleanLabel(item.course)
  const sourceLabel = truncate('Student Hub · ' + (course || '校园事项'), 60)
  const sourceAt = Date.parse(item.created_at || '')
  const excerpt = excerptFor(item)
  return {
    externalId: 'student-hub:item:' + String(item.id),
    title,
    kind: isEvent ? 'event' : 'deadline',
    deadlineIso: isEvent ? null : deadline,
    ...(isEvent && eventStart ? { eventStartIso: eventStart } : {}),
    ...(isEvent && eventEnd ? { eventEndIso: eventEnd } : {}),
    sourceLabel,
    ...(Number.isFinite(sourceAt) && sourceAt >= 0 ? { sourceAtMs: sourceAt } : {}),
    excerpt: excerpt || title,
  }
}

async function readCandidates(nowMs, signal, limit = 64) {
  const root = studentHubRoot()
  const helper = path.join(__dirname, 'read-items.py')
  const helperText = readFileSync(helper, 'utf8').replace(/\r\n/g, '\n')
  if (createHash('sha256').update(helperText, 'utf8').digest('hex') !== HELPER_SHA256) throw new Error('STUDENT_HUB_HELPER_CHANGED')
  const args = [helper, '--config', configPath(root), '--limit', String(limit)]
  if (process.env.LCA_STUDENT_HUB_DB) args.push('--db', process.env.LCA_STUDENT_HUB_DB)
  const { stdout } = await runFile(pythonPath(), ['-B', ...args], {
    cwd: root,
    env: childEnvironment(root),
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    signal,
  })
  const payload = JSON.parse(stdout)
  const items = Array.isArray(payload.items) ? payload.items : []
  return {
    scanned: Number.isSafeInteger(payload.count) ? payload.count : items.length,
    candidates: items.map((item) => toSeed(item, nowMs)).filter(Boolean).slice(0, 32),
  }
}

async function importStudentHubCandidates(_input, context) {
  try {
    context.signal.throwIfAborted()
    const result = await readCandidates(context.nowMs(), context.signal)
    return {
      ok: true,
      raw: { source: 'student-hub', scanned: result.scanned, candidates: result.candidates.length },
      visible: { source: 'student-hub', candidates: result.candidates.length },
      candidates: result.candidates,
    }
  } catch {
    return { ok: false, raw: { error: 'student-hub-unavailable' }, visible: { error: 'student-hub-unavailable' } }
  }
}

async function activate(context) {
  const result = await readCandidates(context.nowMs(), context.signal)
  context.ingestCandidates(result.candidates)
}

module.exports = {
  tools: { import_student_hub_candidates: importStudentHubCandidates },
  activate,
}

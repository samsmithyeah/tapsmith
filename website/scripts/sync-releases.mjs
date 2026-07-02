#!/usr/bin/env node

// Generates the Changelog page (src/content/docs/changelog.md) from the repo's
// published GitHub Releases at build time. Must run AFTER sync-docs.mjs, which
// wipes and recreates src/content/docs.
//
// Release bodies are already markdown (the auto-generated notes from
// `gh release create --generate-notes`, grouped per .github/release.yml). We
// demote their headings one level so each version sits under a `##` heading.
//
// Network/API failures never break the build: we fall back to a placeholder so
// the page (and its sidebar link) always exist. Set GITHUB_TOKEN to avoid the
// low unauthenticated API rate limit.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Matches the GitHub link in astro.config.mjs.
const REPO = 'samsmithyeah/tapsmith'
const OUT_DIR = resolve(import.meta.dirname, '..', 'src', 'content', 'docs')
const OUT_FILE = join(OUT_DIR, 'changelog.md')

const FRONTMATTER = `---
title: "Changelog"
description: "Release notes for every published version of Tapsmith."
---

`

function write(body) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, FRONTMATTER + body)
}

// Demote markdown headings by one level (## -> ###) so release-body category
// headings nest under the per-version `##` heading. Skips fenced code blocks.
function demoteHeadings(md) {
  let inFence = false
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence
      if (inFence) return line
      return line.replace(/^(#{1,5}) /, '#$1 ')
    })
    .join('\n')
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// Drop headings that end up with no bullet items beneath them (e.g. a category
// whose only entries were filtered-out version-bump PRs). Non-bullet lines in
// the block (like the trailing "Full Changelog" link) are preserved.
function removeEmptySections(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      let j = i + 1
      let hasItems = false
      while (j < lines.length && !/^#{1,6}\s/.test(lines[j])) {
        if (/^\s*[*-]\s/.test(lines[j])) hasItems = true
        j++
      }
      if (!hasItems) {
        for (let k = i + 1; k < j; k++) if (lines[k].trim() !== '') out.push(lines[k])
        i = j - 1
        continue
      }
    }
    out.push(lines[i])
  }
  return out
}

// Tidy the auto-generated GitHub notes for the docs page:
//   - strip the "by @user in <pr-url>" attribution from each item
//   - drop version-bump PRs ("Bump version to X.Y.Z")
//   - drop the generic "What's Changed" heading (real category headings stay)
function cleanBody(md) {
  const kept = md
    .split('\n')
    .filter((line) => !/^\s*[*-]\s+bump version\b/i.test(line))
    .filter((line) => !/^#{1,6}\s+what['’]s changed\s*$/i.test(line))
    .map((line) => line.replace(/\s+by @[\w-]+ in https?:\/\/\S+\s*$/i, ''))
  return removeEmptySections(kept)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function renderRelease(r) {
  const heading = `## [${r.name || r.tag_name}](${r.html_url})`
  const date = formatDate(r.published_at)
  const meta = date ? `\n\n_Released ${date}${r.prerelease ? ' · pre-release' : ''}_` : ''
  const body = cleanBody((r.body || '').trim())
  const notes = body ? `\n\n${demoteHeadings(body)}` : '\n\n_No notes for this release._'
  return `${heading}${meta}${notes}`
}

async function main() {
  const headers = { Accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`

  let releases
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
      headers,
    })
    if (!res.ok) throw new Error(`GitHub API returned ${res.status} ${res.statusText}`)
    releases = await res.json()
  } catch (err) {
    console.warn(`[sync-releases] Could not fetch releases (${err.message}). Writing placeholder.`)
    write('Release notes will appear here once the first version is published.\n')
    return
  }

  const published = (Array.isArray(releases) ? releases : []).filter((r) => !r.draft)
  if (published.length === 0) {
    write('Release notes will appear here once the first version is published.\n')
    console.log('[sync-releases] No published releases yet; wrote placeholder.')
    return
  }

  const intro =
    'Release notes for Tapsmith, generated from ' +
    `[GitHub Releases](https://github.com/${REPO}/releases).\n\n`
  write(intro + published.map(renderRelease).join('\n\n') + '\n')
  console.log(`[sync-releases] Wrote ${published.length} release(s) to changelog.md`)
}

main()

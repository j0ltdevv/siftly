import fs from 'fs/promises'
import path from 'path'
import prisma from '@/lib/db'

export interface ObsidianExportResult {
  written: number
  skipped: number
  errors: Array<{ tweetId: string; error: string }>
  indexesWritten: number
}

interface ObsidianExportOptions {
  vaultPath: string
  subfolder?: string
  overwrite?: boolean
  categoryFilter?: string
}

interface MediaItemRow {
  type: string
  url: string
  thumbnailUrl: string | null
}

interface CategoryJoin {
  category: {
    name: string
    slug: string
    color: string
  }
}

interface BookmarkRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: Date | null
  importedAt: Date
  semanticTags: string | null
  entities: string | null
  mediaItems: MediaItemRow[]
  categories: CategoryJoin[]
}

/**
 * Validate that vaultPath is safe:
 * - Must be an absolute path
 * - Must be an existing directory
 * - Must be under the user's home directory (not system paths)
 */
export async function validateVaultPath(vaultPath: string): Promise<{ valid: boolean; error?: string }> {
  const resolved = path.resolve(vaultPath)

  if (!path.isAbsolute(resolved)) {
    return { valid: false, error: 'Vault path must be absolute' }
  }

  // Block system paths
  const blocked = ['/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/dev', '/proc', '/sys']
  if (blocked.some(p => resolved === p || resolved.startsWith(p + '/'))) {
    return { valid: false, error: 'Cannot write to system directories' }
  }

  try {
    const stat = await fs.stat(resolved)
    if (!stat.isDirectory()) {
      return { valid: false, error: 'Path is not a directory' }
    }
  } catch {
    return { valid: false, error: 'Directory does not exist' }
  }

  return { valid: true }
}

export function sanitizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_/]/g, '')
    .replace(/-+/g, '-')
    .trim()
}

export function sanitizeFilename(str: string): string {
  return str.replace(/[<>:"/\\|?*\n\r]/g, '').trim()
}

function noteFilename(bookmark: BookmarkRow): string {
  const date = bookmark.tweetCreatedAt
    ? new Date(bookmark.tweetCreatedAt).toISOString().split('T')[0]
    : 'unknown'
  const author = sanitizeFilename(bookmark.authorHandle || 'unknown')
  return `${date} - @${author} - ${bookmark.tweetId}.md`
}

function buildNoteMarkdown(bookmark: BookmarkRow): string {
  const tags: string[] = ['twitter/bookmark']

  if (bookmark.authorHandle) {
    tags.push(`author/${sanitizeTag(bookmark.authorHandle)}`)
  }

  let semanticTags: string[] = []
  try { semanticTags = JSON.parse(bookmark.semanticTags || '[]') } catch {}
  semanticTags.forEach(t => { const c = sanitizeTag(t); if (c) tags.push(c) })

  const categories = bookmark.categories.map((bc) => bc.category.name)
  categories.forEach((c) => tags.push(`category/${sanitizeTag(c)}`))

  const date = bookmark.tweetCreatedAt
    ? new Date(bookmark.tweetCreatedAt).toISOString().split('T')[0]
    : null
  const sourceUrl = `https://x.com/${bookmark.authorHandle}/status/${bookmark.tweetId}`

  const frontmatter = [
    '---',
    `tweet_id: "${bookmark.tweetId}"`,
    `author: "${bookmark.authorHandle || ''}"`,
    `author_name: "${(bookmark.authorName || '').replace(/"/g, "'")}"`,
    date ? `date: ${date}` : null,
    `source: "${sourceUrl}"`,
    `categories: [${categories.map((c) => `"${c}"`).join(', ')}]`,
    `tags:`,
    ...tags.map(t => `  - ${t}`),
    '---',
  ].filter(Boolean).join('\n')

  const lines: string[] = [frontmatter, '', bookmark.text || '']

  if (bookmark.mediaItems.length > 0) {
    lines.push('', '## Media', '')
    for (const item of bookmark.mediaItems) {
      if (item.type === 'photo') {
        lines.push(`![](${item.url})`)
      } else {
        lines.push(`[${item.type.toUpperCase()}](${item.url})`)
      }
    }
  }

  lines.push('', '## Source', '', `[View on X](${sourceUrl})`)
  return lines.join('\n')
}

function buildCategoryIndex(
  categoryName: string,
  bookmarks: BookmarkRow[]
): string {
  const tag = sanitizeTag(categoryName)
  const links = bookmarks
    .map(b => `- [[${noteFilename(b).replace(/\.md$/, '')}]]`)
    .join('\n')

  return [
    '---',
    `type: index`,
    `category: "${categoryName}"`,
    `tags:`,
    `  - index/category`,
    `  - category/${tag}`,
    '---',
    '',
    `# ${categoryName}`,
    '',
    `${bookmarks.length} bookmarks`,
    '',
    '## Bookmarks',
    '',
    links,
  ].join('\n')
}

function buildAuthorIndex(
  handle: string,
  displayName: string,
  bookmarks: BookmarkRow[]
): string {
  const links = bookmarks
    .map(b => `- [[${noteFilename(b).replace(/\.md$/, '')}]]`)
    .join('\n')

  return [
    '---',
    `type: index`,
    `author: "${handle}"`,
    `author_name: "${displayName.replace(/"/g, "'")}"`,
    `tags:`,
    `  - index/author`,
    `  - author/${sanitizeTag(handle)}`,
    '---',
    '',
    `# @${handle}`,
    '',
    `${bookmarks.length} bookmarks`,
    '',
    '## Bookmarks',
    '',
    links,
  ].join('\n')
}

export async function exportToObsidian(options: ObsidianExportOptions): Promise<ObsidianExportResult> {
  const { vaultPath, subfolder = 'Twitter Bookmarks', overwrite = false, categoryFilter } = options

  // Validate path before writing
  const validation = await validateVaultPath(vaultPath)
  if (!validation.valid) {
    throw new Error(`Invalid vault path: ${validation.error}`)
  }

  // Sanitize subfolder to prevent path traversal via subfolder param
  const safeSubfolder = sanitizeFilename(subfolder)
  const notesDir = path.join(vaultPath, safeSubfolder)
  const indexDir = path.join(notesDir, '_index')

  // Verify the resolved paths are still under vaultPath
  const resolvedNotesDir = path.resolve(notesDir)
  const resolvedVaultPath = path.resolve(vaultPath)
  if (!resolvedNotesDir.startsWith(resolvedVaultPath + '/') && resolvedNotesDir !== resolvedVaultPath) {
    throw new Error('Subfolder path escapes vault directory')
  }

  await fs.mkdir(notesDir, { recursive: true })
  await fs.mkdir(indexDir, { recursive: true })

  const where = categoryFilter
    ? { categories: { some: { category: { slug: categoryFilter } } } }
    : {}

  const bookmarks = await prisma.bookmark.findMany({
    where,
    include: {
      mediaItems: true,
      categories: { include: { category: true } },
    },
    orderBy: { tweetCreatedAt: 'desc' },
  }) as BookmarkRow[]

  const result: ObsidianExportResult = { written: 0, skipped: 0, errors: [], indexesWritten: 0 }

  for (const bookmark of bookmarks) {
    const filename = noteFilename(bookmark)
    const filePath = path.join(notesDir, filename)

    if (!overwrite) {
      try { await fs.access(filePath); result.skipped++; continue } catch {}
    }

    try {
      await fs.writeFile(filePath, buildNoteMarkdown(bookmark), 'utf-8')
      result.written++
    } catch (err: unknown) {
      result.errors.push({
        tweetId: bookmark.tweetId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const byCategory = new Map<string, BookmarkRow[]>()
  for (const bookmark of bookmarks) {
    for (const bc of bookmark.categories) {
      const name = bc.category.name
      if (!byCategory.has(name)) byCategory.set(name, [])
      byCategory.get(name)!.push(bookmark)
    }
  }
  for (const [categoryName, categoryBookmarks] of byCategory) {
    const filename = `_${sanitizeFilename(categoryName)}.md`
    const filePath = path.join(indexDir, filename)
    await fs.writeFile(filePath, buildCategoryIndex(categoryName, categoryBookmarks), 'utf-8')
    result.indexesWritten++
  }

  const byAuthor = new Map<string, { displayName: string; bookmarks: BookmarkRow[] }>()
  for (const bookmark of bookmarks) {
    const handle = bookmark.authorHandle || 'unknown'
    if (!byAuthor.has(handle)) {
      byAuthor.set(handle, { displayName: bookmark.authorName || handle, bookmarks: [] })
    }
    byAuthor.get(handle)!.bookmarks.push(bookmark)
  }
  for (const [handle, { displayName, bookmarks: authorBookmarks }] of byAuthor) {
    const filename = `@${sanitizeFilename(handle)}.md`
    const filePath = path.join(indexDir, filename)
    await fs.writeFile(filePath, buildAuthorIndex(handle, displayName, authorBookmarks), 'utf-8')
    result.indexesWritten++
  }

  return result
}

// ---------------------------------------------------------------------------
// Twitter-Graph vault export — structured notes with fact-check frontmatter
// Layout: Bookmarks/{id}.md, _index.md (Dataview), _index/authors/@{h}.md, media/
// Idempotent: every generated file is fully overwritten on each run.
// ---------------------------------------------------------------------------

export interface VaultBookmark {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  source: string
  tweetCreatedAt: Date | null
  importedAt: Date
  enrichmentMeta: string | null
  verdict: string | null
  confidence: number | null
  ai_summary: string | null
  keep_score: number | null
  mediaItems: Array<{ type: string; url: string; localPath: string | null }>
  categories: CategoryJoin[]
}

export interface VaultExportResult {
  count: number
  files: string[]
  errors: Array<{ id: string; error: string }>
}

/** JSON double-quoted scalars are valid YAML 1.2 — safe escaping for arbitrary strings. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

function noteTitle(b: VaultBookmark): string {
  const flat = (b.text || '').replace(/\s+/g, ' ').trim()
  if (flat.length > 80) return `${flat.slice(0, 79)}…`
  return flat || `@${b.authorHandle} — ${b.tweetId}`
}

function sourceUrl(b: VaultBookmark): string {
  return `https://x.com/${b.authorHandle}/status/${b.tweetId}`
}

function noteDate(b: VaultBookmark): string {
  return (b.tweetCreatedAt ?? b.importedAt).toISOString().split('T')[0]
}

/** Verifiable claims persisted by /api/factcheck into enrichmentMeta.factCheck.verifiedClaims. */
export function extractClaims(enrichmentMeta: string | null): string[] {
  if (!enrichmentMeta) return []
  try {
    const parsed = JSON.parse(enrichmentMeta) as { factCheck?: { verifiedClaims?: unknown } }
    const claims = parsed?.factCheck?.verifiedClaims
    if (!Array.isArray(claims)) return []
    return claims.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
  } catch {
    return []
  }
}

export function buildBookmarkNote(b: VaultBookmark, mediaLines: string[] = []): string {
  const categories = b.categories.map(c => c.category.name)
  const tags = [`twitter/${sanitizeTag(b.source) || 'bookmark'}`]
  if (b.authorHandle) tags.push(`author/${sanitizeTag(b.authorHandle)}`)
  categories.forEach(c => { const t = sanitizeTag(c); if (t) tags.push(`category/${t}`) })

  const fm: string[] = [
    '---',
    `tweet_id: ${yamlString(b.tweetId)}`,
    `title: ${yamlString(noteTitle(b))}`,
    `author: ${yamlString(`@${b.authorHandle}`)}`,
    `author_name: ${yamlString(b.authorName)}`,
    `date: ${noteDate(b)}`,
    `url: ${yamlString(sourceUrl(b))}`,
    `source: ${yamlString(b.source)}`,
  ]
  if (b.verdict) fm.push(`verdict: ${yamlString(b.verdict)}`)
  if (b.confidence !== null && b.confidence !== undefined) fm.push(`confidence: ${b.confidence}`)
  if (b.keep_score !== null && b.keep_score !== undefined) fm.push(`keep_score: ${b.keep_score}`)
  if (categories.length > 0) fm.push(`categories: [${categories.map(yamlString).join(', ')}]`)
  fm.push('tags:', ...tags.map(t => `  - ${t}`), '---')

  const claims = extractClaims(b.enrichmentMeta)
  const authorFile = `@${sanitizeFilename(b.authorHandle) || 'unknown'}`
  const original = (b.text || '').split('\n').map(line => `> ${line}`).join('\n')

  const lines: string[] = [...fm, '']
  if (b.ai_summary) lines.push('## Summary', '', b.ai_summary, '')
  if (claims.length > 0) lines.push('## Claims', '', ...claims.map(c => `- ${c}`), '')
  lines.push('## Original', '', original, '')
  if (mediaLines.length > 0) lines.push('## Media', '', ...mediaLines, '')
  lines.push(
    '## Links',
    '',
    `- Author: [[authors/${authorFile}|@${b.authorHandle}]]`,
    '- Library: [[_index]]',
    '',
    `[View on X](${sourceUrl(b)})`,
    '',
  )
  return lines.join('\n')
}

export function buildAuthorNote(
  handle: string,
  displayName: string,
  entries: Array<{ id: string; title: string }>
): string {
  const links = entries
    .map(e => `- [[Bookmarks/${e.id}|${e.title.replace(/[[\]|\n]/g, ' ').trim() || e.id}]]`)
    .join('\n')
  return [
    '---',
    'type: author',
    `handle: ${yamlString(handle)}`,
    `name: ${yamlString(displayName)}`,
    'tags:',
    '  - index/author',
    `  - author/${sanitizeTag(handle)}`,
    '---',
    '',
    `# @${handle}`,
    '',
    `${entries.length} bookmark${entries.length === 1 ? '' : 's'}.`,
    '',
    '## Bookmarks',
    '',
    links,
    '',
    '[[_index]]',
    '',
  ].join('\n')
}

export function buildRootIndex(total: number): string {
  return [
    '---',
    'type: index',
    'tags:',
    '  - index/library',
    '---',
    '',
    '# Twitter Graph',
    '',
    `${total} bookmarks.`,
    '',
    '```dataview',
    'TABLE author, verdict, confidence, keep_score, date',
    'FROM "Bookmarks" OR "Twitter-Graph/Bookmarks"',
    'SORT keep_score DESC',
    '```',
    '',
  ].join('\n')
}

function safeMediaExt(localPath: string, type: string): string {
  const ext = path.extname(localPath)
  if (/^\.[a-zA-Z0-9]{1,5}$/.test(ext)) return ext.toLowerCase()
  if (type === 'video' || type === 'gif') return '.mp4'
  return '.jpg'
}

/**
 * Media embed lines per item: copy to vault media/ when a readable localPath
 * exists; otherwise link the remote URL. Copy failures degrade to remote links.
 */
async function buildMediaLines(b: VaultBookmark, vaultMediaDir: string, files: string[]): Promise<string[]> {
  const lines: string[] = []
  let idx = 0
  for (const item of b.mediaItems) {
    idx++
    if (item.localPath) {
      try {
        const abs = path.resolve(item.localPath)
        const stat = await fs.stat(abs)
        if (stat.isFile()) {
          const dest = `${sanitizeFilename(b.tweetId)}-${idx}${safeMediaExt(abs, item.type)}`
          await fs.copyFile(abs, path.join(vaultMediaDir, dest))
          files.push(`media/${dest}`)
          lines.push(`![[media/${dest}]]`)
          continue
        }
      } catch {
        // local file unreadable — fall through to remote link
      }
    }
    if (item.type === 'photo') lines.push(`![photo](${item.url})`)
    else lines.push(`[${item.type.toUpperCase()}](${item.url})`)
  }
  return lines
}

/**
 * Resolve the target vault: DB setting → OBSIDIAN_VAULT_PATH env → sibling
 * Obsidian/Twitter-Graph of the siftly project. Null when none exists.
 */
export async function resolveVaultPath(): Promise<string | null> {
  const setting = await prisma.setting.findUnique({ where: { key: 'obsidianVaultPath' } })
  if (setting?.value) return setting.value
  if (process.env.OBSIDIAN_VAULT_PATH) return process.env.OBSIDIAN_VAULT_PATH
  const sibling = path.resolve(process.cwd(), '..', 'Obsidian', 'Twitter-Graph')
  try {
    const stat = await fs.stat(sibling)
    if (stat.isDirectory()) return sibling
  } catch {
    // not present
  }
  return null
}

export async function exportBookmarksToVault(vaultPath: string): Promise<VaultExportResult> {
  const validation = await validateVaultPath(vaultPath)
  if (!validation.valid) {
    throw new Error(`Invalid vault path: ${validation.error}`)
  }

  const resolvedVault = path.resolve(vaultPath)
  const notesDir = path.join(resolvedVault, 'Bookmarks')
  const authorsDir = path.join(resolvedVault, '_index', 'authors')
  const mediaDir = path.join(resolvedVault, 'media')
  await fs.mkdir(notesDir, { recursive: true })
  await fs.mkdir(authorsDir, { recursive: true })
  await fs.mkdir(mediaDir, { recursive: true })

  const bookmarks = (await prisma.bookmark.findMany({
    include: {
      mediaItems: true,
      categories: { include: { category: true } },
    },
    orderBy: { tweetCreatedAt: 'desc' },
  })) as unknown as VaultBookmark[]

  const result: VaultExportResult = { count: 0, files: [], errors: [] }
  const byAuthor = new Map<string, { displayName: string; entries: Array<{ id: string; title: string }> }>()

  for (const b of bookmarks) {
    try {
      const mediaLines = await buildMediaLines(b, mediaDir, result.files)
      const noteFile = `${sanitizeFilename(b.id)}.md`
      await fs.writeFile(path.join(notesDir, noteFile), buildBookmarkNote(b, mediaLines), 'utf-8')
      result.files.push(`Bookmarks/${noteFile}`)
      result.count++

      const handle = b.authorHandle || 'unknown'
      if (!byAuthor.has(handle)) {
        byAuthor.set(handle, { displayName: b.authorName || handle, entries: [] })
      }
      byAuthor.get(handle)!.entries.push({ id: b.id, title: noteTitle(b) })
    } catch (err: unknown) {
      result.errors.push({ id: b.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const indexFile = '_index.md'
  await fs.writeFile(path.join(resolvedVault, indexFile), buildRootIndex(result.count), 'utf-8')
  result.files.push(indexFile)

  for (const [handle, { displayName, entries }] of byAuthor) {
    const authorFile = `_index/authors/@${sanitizeFilename(handle) || 'unknown'}.md`
    await fs.writeFile(path.join(resolvedVault, authorFile), buildAuthorNote(handle, displayName, entries), 'utf-8')
    result.files.push(authorFile)
  }

  return result
}

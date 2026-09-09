import { NextRequest, NextResponse } from 'next/server'
import { exportToObsidian, validateVaultPath, exportBookmarksToVault, resolveVaultPath } from '@/lib/obsidian-exporter'
import prisma from '@/lib/db'

/**
 * GET /api/export?format=obsidian (also served at /api/export/obsidian)
 * Triggers Twitter-Graph vault generation and returns { count, files[] }.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const format = searchParams.get('format')
  if (format !== 'obsidian') {
    return NextResponse.json(
      { error: 'Missing or unsupported query param: format=obsidian' },
      { status: 400 }
    )
  }

  const vaultPath = await resolveVaultPath()
  if (!vaultPath) {
    return NextResponse.json(
      { error: 'Obsidian vault not found. Configure the path in Settings.' },
      { status: 400 }
    )
  }

  try {
    const result = await exportBookmarksToVault(vaultPath)
    return NextResponse.json(result)
  } catch (err: unknown) {
    console.error('Obsidian vault export error:', err)
    return NextResponse.json(
      { error: `Export failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { category?: string; overwrite?: boolean } = {}
  try {
    body = await request.json()
  } catch {
    // body stays as defaults
  }

  const { category, overwrite = false } = body

  const setting = await prisma.setting.findUnique({ where: { key: 'obsidianVaultPath' } })
  if (!setting?.value) {
    return NextResponse.json(
      { error: 'Obsidian vault path not configured. Add it in Settings.' },
      { status: 400 }
    )
  }

  const validation = await validateVaultPath(setting.value)
  if (!validation.valid) {
    return NextResponse.json(
      { error: `Invalid vault path: ${validation.error}` },
      { status: 400 }
    )
  }

  try {
    const result = await exportToObsidian({
      vaultPath: setting.value,
      subfolder: 'Twitter Bookmarks',
      overwrite,
      categoryFilter: category,
    })
    return NextResponse.json(result)
  } catch (err: unknown) {
    console.error('Obsidian export error:', err)
    return NextResponse.json(
      { error: 'Export failed. Check server logs for details.' },
      { status: 500 }
    )
  }
}

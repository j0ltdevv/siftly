import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import prisma from '@/lib/db'
import crypto from 'crypto'

// The nvidia-claude-proxy only exposes the Anthropic Messages API (/v1/messages)
// and translates it to OpenAI chat completions -> NIM upstream.
// ANTHROPIC_API_KEY must match the proxy's SERVER_API_KEY.
const anthropic = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL || 'http://localhost:8089',
  apiKey: process.env.ANTHROPIC_API_KEY || '',
})

const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b'

/**
 * Call the LLM with retries — the NIM upstream intermittently returns
 * 503 "Service temporarily overloaded" in bursts.
 */
async function callLLM(prompt: string, maxTokens: number): Promise<string> {
  const maxAttempts = 4
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: process.env.AI_MODEL || DEFAULT_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      })
      // Concatenate all text blocks (some models return reasoning + text blocks)
      return response.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 3000))
      }
    }
  }
  throw lastError
}

/**
 * Extract the first balanced JSON object from free text.
 */
function extractJsonObject(content: string): string | null {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i)
  const candidates: string[] = []
  if (fenced) candidates.push(fenced[1].trim())
  const start = content.indexOf('{')
  if (start !== -1) {
    let depth = 0
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') depth++
      else if (content[i] === '}') {
        depth--
        if (depth === 0) {
          candidates.push(content.slice(start, i + 1))
          break
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // try next candidate
    }
  }
  return null
}

// Exa API endpoint for fact-checking
const EXA_API_URL = 'https://api.exa.ai/search'

interface FactCheckResult {
  verdict: 'TRUE' | 'FALSE' | 'MISLEADING' | 'UNVERIFIABLE'
  confidence: number // 0-100
  summary: string // 2-line summary
  sources: string[] // URLs of evidence
  keep_score: number // 0-10
  reason_keep: string // why interesting or not
}

interface Claim {
  statement: string
  context: string
}

/**
 * Extract verifiable claims from tweet text using LLM
 */
async function extractClaims(tweetText: string): Promise<Claim[]> {
  const prompt = `Extract 3-5 verifiable factual claims from the following Twitter/X tweet.
  Only extract claims that can be true/false verified.
  Format as JSON array: [{"statement": "claim text", "context": "brief context"}]

  Tweet: "${tweetText}"`

  try {
    const content = await callLLM(prompt, 1500)

    const fencedMatch = content.match(/```json\s*([\s\S]*?)```/i)
    const arrMatch = content.match(/\[[\s\S]*\]/)
    const candidates = [fencedMatch?.[1], arrMatch?.[0]].filter(Boolean) as string[]
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate)
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].statement) {
          return parsed as Claim[]
        }
      } catch {
        // try next candidate
      }
    }
    console.error('Claims JSON parse failed. Raw content:', content.substring(0, 500))
    return []
  } catch (error) {
    console.error('Error extracting claims:', error)
    return []
  }
}

/**
 * Call Exa API to verify claims
 * Uses POST with x-api-key header and JSON body per Exa API spec.
 */
async function verifyWithExa(claims: Claim[]): Promise<{ [key: string]: { verified: boolean; evidence: string; source: string } }> {
  const results: { [key: string]: { verified: boolean; evidence: string; source: string } } = {}

  for (const claim of claims) {
    try {
      const response = await fetch(EXA_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': process.env.EXA_API_KEY || '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: claim.statement,
          numResults: 3,
          type: 'auto',
          contents: { text: true },
        }),
      })

      if (response.ok) {
        const data = await response.json()
        // Exa API returns search results - determine verdict based on results
        if (data.results && data.results.length > 0) {
          // Simple heuristic: if we find relevant results, claim is verifiable
          results[claim.statement] = {
            verified: true,
            evidence: data.results[0]?.text || 'No evidence found',
            source: data.results[0]?.url || 'unknown',
          }
        } else {
          results[claim.statement] = {
            verified: false,
            evidence: 'No relevant results found',
            source: 'none',
          }
        }
      } else {
        await response.text()
        results[claim.statement] = {
          verified: false,
          evidence: 'Exa API error',
          source: 'none',
        }
      }
    } catch (error) {
      console.error('Error calling Exa API:', error)
      results[claim.statement] = {
        verified: false,
        evidence: 'Error calling Exa API',
        source: 'none',
      }
    }
  }

  return results
}

/**
 * Ask NIM LLM to give final verdict based on evidence
 */
async function getVerdictFromLLM(claims: Claim[], exaResults: Record<string, { verified: boolean; evidence: string; source: string }>): Promise<FactCheckResult> {
  // Build evidence summary for the LLM, limited to 3 claims
  const evidenceSummary = Object.entries(exaResults)
    .slice(0, 3)
    .map(([statement, result]) => {
      return `- Claim: "${statement}"\n  Verified: ${result.verified}\n  Evidence: ${result.evidence.substring(0, 200)}${result.evidence.length > 200 ? '...' : ''}\n  Source: ${result.source}`
    })
    .join('\n\n')

  const prompt = `You are an fact-checking AI. Given the following claims and evidence, provide a verdict.

  CLAIMS:
  ${evidenceSummary}

  For each claim, determine:
  - verdict: "TRUE", "FALSE", "MISLEADING", or "UNVERIFIABLE"
  - confidence: 0-100 (how confident are you)
  - summary: 2-line summary of what it means
  - keep_score: 0-10 (how interesting/important this claim is for the user's knowledge base)
  - reason_keep: "why this claim is interesting or not interesting for the user's Twitter bookmark knowledge base"

  Return JSON: {
    "verdict": "TRUE|FALSE|MISLEADING|UNVERIFIABLE",
    "confidence": number,
    "summary": "2-line summary",
    "sources": ["url1", "url2"],
    "keep_score": 0-10,
    "reason_keep": "why interesting or not"
  }`

  try {
    const content = await callLLM(prompt, 1000)

    const jsonMatch = extractJsonObject(content)
    if (jsonMatch) {
      return JSON.parse(jsonMatch)
    }
    console.error('Verdict JSON parse failed. Raw content:', content.substring(0, 500))

    // Fallback default values
    return {
      verdict: 'UNVERIFIABLE',
      confidence: 0,
      summary: 'Could not parse LLM response',
      sources: [],
      keep_score: 0,
      reason_keep: 'LLM response parse failure',
    }
  } catch (error) {
    console.error('Error getting verdict from LLM:', error)
    return {
      verdict: 'UNVERIFIABLE',
      confidence: 0,
      summary: 'Error calling LLM',
      sources: [],
      keep_score: 0,
      reason_keep: 'LLM call failure',
    }
  }
}
/**
 * Main fact-check handler for a bookmark
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    let { tweetId, tweetText, authorHandle } = body

    // Allow fact-checking by tweetId alone: look up the bookmark text in the DB
    if (!tweetText && tweetId) {
      const bookmark = await prisma.bookmark.findUnique({
        where: { tweetId },
        select: { text: true, authorHandle: true },
      })
      if (!bookmark) {
        return new Response(
          JSON.stringify({ error: 'Bookmark not found for tweetId: ' + tweetId }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        )
      }
      tweetText = bookmark.text
      authorHandle = authorHandle || bookmark.authorHandle
    }

    if (!tweetText) {
      return new Response(
        JSON.stringify({ error: 'tweetText is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Step 1: Extract claims from tweet text
    const claims = await extractClaims(tweetText)
    if (claims.length === 0) {
      // No claims extracted, mark as unverifiable
      return new Response(
        JSON.stringify({
          verdict: 'UNVERIFIABLE',
          confidence: 0,
          summary: 'No verifiable claims found in tweet',
          sources: [],
          keep_score: 5,
          reason_keep: 'No specific claims to fact-check',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Step 2: Verify claims with Exa API
    const exaResults = await verifyWithExa(claims)

    // Step 3: Get final verdict from NIM LLM
    const factCheckResult = await getVerdictFromLLM(claims, exaResults)

    // Step 4: Write result to database (Prisma)
    // If tweetId is provided, update existing bookmark; if not, create a minimal one
    if (tweetId) {
      await prisma.bookmark.update({
        where: { tweetId },
        data: {
          verdict: factCheckResult.verdict,
          confidence: factCheckResult.confidence,
          ai_summary: factCheckResult.summary,
          keep_score: factCheckResult.keep_score,
          enrichedAt: new Date(),
          enrichmentMeta: JSON.stringify({
            factCheck: {
              verifiedClaims: Object.keys(exaResults),
              sources: factCheckResult.sources,
            },
          }),
        },
      })
    } else {
      // No tweetId provided - create a minimal bookmark entry
      await prisma.bookmark.create({
        data: {
          tweetId: crypto.randomUUID(),
          text: tweetText,
          authorHandle: authorHandle || 'unknown',
          authorName: authorHandle || 'unknown',
          rawJson: JSON.stringify({ text: tweetText, source: 'factcheck-api' }),
          source: 'factcheck',
          verdict: factCheckResult.verdict,
          confidence: factCheckResult.confidence,
          ai_summary: factCheckResult.summary,
          keep_score: factCheckResult.keep_score,
          enrichedAt: new Date(),
          enrichmentMeta: JSON.stringify({
            factCheck: {
              verifiedClaims: Object.keys(exaResults),
              sources: factCheckResult.sources,
            },
          }),
        },
      })
    }

    return new Response(
      JSON.stringify(factCheckResult),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error in fact-check handler:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

/**
 * GET endpoint to check fact-check status for a bookmark
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const tweetId = searchParams.get('tweetId')

  if (!tweetId) {
    return new Response(
      JSON.stringify({ error: 'tweetId parameter is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  try {
    const bookmark = await prisma.bookmark.findUnique({
      where: { tweetId },
      select: {
        verdict: true,
        confidence: true,
        ai_summary: true,
        keep_score: true,
      },
    })

    if (!bookmark) {
      return new Response(
        JSON.stringify({ error: 'Bookmark not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify(bookmark),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error fetching fact-check status:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
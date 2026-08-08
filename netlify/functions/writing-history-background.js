// Background function: name MUST end in "-background" for Netlify to run it async.
// Netlify returns 202 immediately on invocation; this keeps running for up to 15 minutes
// and writes its result straight into Supabase rather than returning it over HTTP.

const SUPABASE_URL = 'https://ydxriywpkkdptwcuqaaj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkeHJpeXdwa2tkcHR3Y3VxYWFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1Njc5NjYsImV4cCI6MjA5NDE0Mzk2Nn0.SYACMatBKKEZV0Wo3rJ6iPSzt0E14qXjT2DieUsG9Zk';

async function upsertResult(row, accessToken){
  const r = await fetch(SUPABASE_URL + '/rest/v1/pl_artist_writing_stats?on_conflict=user_id,artist_name_key', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + accessToken,
      'Content-Profile': 'pitch_log',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(row)
  });
  if (!r.ok) {
    const t = await r.text();
    console.log('Supabase upsert failed:', r.status, t);
  }
}

function failRow(userId, artist, note) {
  return {
    user_id: userId,
    artist_name_key: artist.trim().toLowerCase(),
    artist_name: artist,
    co_write_pct: null,
    outside_pct: null,
    songs_sampled: [],
    confidence: 'low',
    notes: note,
    sources: [],
    researched_at: new Date().toISOString()
  };
}

exports.handler = async function(event) {
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch(e) {
    console.log('Bad payload:', e.message);
    return { statusCode: 200, body: '' };
  }

  const artist = payload.artist;
  const userId = payload.userId;
  const accessToken = payload.accessToken;

  if (!artist || !userId || !accessToken) {
    console.log('Missing artist, userId, or accessToken');
    return { statusCode: 200, body: '' };
  }

  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!firecrawlKey) {
    console.log('FIRECRAWL_API_KEY not configured');
    await upsertResult(failRow(userId, artist, 'Research failed — Firecrawl API key not configured.'), accessToken).catch(function(){});
    return { statusCode: 200, body: '' };
  }
  if (!anthropicKey) {
    console.log('ANTHROPIC_API_KEY not configured');
    await upsertResult(failRow(userId, artist, 'Research failed — Anthropic API key not configured.'), accessToken).catch(function(){});
    return { statusCode: 200, body: '' };
  }

  // ── Firecrawl search helper ─────────────────────────────────────────────
  // Mirrors search-contact.js. Uses markdown (not summary) since we need the
  // actual per-song writing-credit detail off discography/credit pages, not
  // just a blurb.
  async function fcSearch(query, limit) {
    console.log('Firecrawl search:', query);
    const r = await fetch('https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + firecrawlKey
      },
      body: JSON.stringify({
        query: query,
        limit: limit || 3,
        scrapeOptions: { formats: [{ type: 'markdown' }] }
      })
    });
    const data = await r.json();
    if (!data.success) {
      console.log('Firecrawl error for query "' + query + '":', JSON.stringify(data));
      return '';
    }
    // v2 search returns { success, data: { web: [...] } } — not a bare array.
    const items = (data.data && data.data.web) || [];
    console.log('Firecrawl results for "' + query + '":', items.length);
    return items.map(function(item) {
      // Cap each page's markdown so three-plus pages don't blow past context.
      const body = (item.markdown || item.description || '').slice(0, 4000);
      return '### ' + (item.title || item.url) + '\n'
        + (item.url || '') + '\n'
        + body;
    }).join('\n\n');
  }

  try {
    // Run targeted searches in parallel; don't let one failure kill the request
    const results = await Promise.allSettled([
      fcSearch(artist + ' discography wikipedia', 2),
      fcSearch(artist + ' songwriter writing credits genius.com', 3),
      fcSearch(artist + ' co-writer credits latest album singles', 3)
    ]);

    const discogCtx = results[0].status === 'fulfilled' ? results[0].value : '';
    const creditsCtx = results[1].status === 'fulfilled' ? results[1].value : '';
    const recentCtx = results[2].status === 'fulfilled' ? results[2].value : '';

    if (!discogCtx && !creditsCtx && !recentCtx) {
      console.log('No Firecrawl results found for', artist);
      await upsertResult(failRow(userId, artist, 'No search results found for this artist.'), accessToken);
      return { statusCode: 200, body: '' };
    }

    const prompt = 'Using ONLY the research notes below, analyze the country music artist "' + artist + '" '
      + 'and their released discography (prioritize their most recent album plus singles from roughly the '
      + 'last 3-4 years). For each song you can confirm from the notes, determine whether the artist is '
      + 'credited as a co-writer/writer versus a song written entirely by outside songwriters (the artist '
      + 'recorded it but has no writing credit). Be conservative: only count a song if the notes actually '
      + 'support the writing credit, and say clearly if the data is thin. Do not invent songs, credits, or '
      + 'sources that are not supported by the notes below — only cite URLs that actually appear in the notes.\n\n'
      + '--- DISCOGRAPHY RESEARCH ---\n' + (discogCtx || 'No results.') + '\n\n'
      + '--- WRITING CREDITS RESEARCH ---\n' + (creditsCtx || 'No results.') + '\n\n'
      + '--- RECENT SINGLES/CREDITS RESEARCH ---\n' + (recentCtx || 'No results.') + '\n\n'
      + 'Return ONLY valid JSON with no markdown, no explanation:\n'
      + '{"artist":"","estimatedCoWritePct":0,"estimatedOutsidePct":0,'
      + '"songsSampled":[{"title":"","hasWritingCredit":true}],'
      + '"confidence":"high|medium|low","notes":"","sources":[""]}';

    console.log('Calling Anthropic API (no web_search tool)...');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) console.log('API error:', JSON.stringify(data.error));

    const text = (data.content || [])
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('');

    const match = text.match(/\{[\s\S]*\}/);
    let parsed = null;
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch(e) { console.log('JSON parse failed:', e.message); }
    }

    const row = {
      user_id: userId,
      artist_name_key: artist.trim().toLowerCase(),
      artist_name: (parsed && parsed.artist) || artist,
      co_write_pct: parsed ? parsed.estimatedCoWritePct : null,
      outside_pct: parsed ? parsed.estimatedOutsidePct : null,
      songs_sampled: parsed ? (parsed.songsSampled || []) : [],
      confidence: parsed ? (parsed.confidence || 'low') : 'low',
      notes: parsed ? (parsed.notes || '') : 'Research failed — try refreshing.',
      sources: parsed ? (parsed.sources || []) : [],
      researched_at: new Date().toISOString()
    };
    await upsertResult(row, accessToken);

  } catch(err) {
    console.log('Background writing-history error:', err.message);
    await upsertResult(failRow(userId, artist, 'Research failed: ' + err.message), accessToken).catch(function(){});
  }

  return { statusCode: 200, body: '' };
};

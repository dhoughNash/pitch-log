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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('ANTHROPIC_API_KEY not configured');
    return { statusCode: 200, body: '' };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: 'Research the country music artist "' + artist + '" and their released discography '
            + '(prioritize their most recent album plus singles from roughly the last 3-4 years). For each '
            + 'song you can confirm, determine whether the artist is credited as a co-writer/writer versus '
            + 'a song written entirely by outside songwriters (the artist recorded it but has no writing credit). '
            + 'Use at most 4 web searches total, favoring song-credit databases, Wikipedia discography pages, or '
            + 'Genius credit pages. Be conservative: only count a song if you can actually verify the writing '
            + 'credits, and say clearly if data is thin. '
            + 'Return ONLY valid JSON with no markdown, no explanation:\n'
            + '{"artist":"","estimatedCoWritePct":0,"estimatedOutsidePct":0,'
            + '"songsSampled":[{"title":"","hasWritingCredit":true}],'
            + '"confidence":"high|medium|low","notes":"","sources":[""]}'
        }]
      })
    });

    const data = await response.json();
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
    await upsertResult({
      user_id: userId,
      artist_name_key: artist.trim().toLowerCase(),
      artist_name: artist,
      co_write_pct: null,
      outside_pct: null,
      songs_sampled: [],
      confidence: 'low',
      notes: 'Research failed: ' + err.message,
      sources: [],
      researched_at: new Date().toISOString()
    }, accessToken).catch(function(){});
  }

  return { statusCode: 200, body: '' };
};

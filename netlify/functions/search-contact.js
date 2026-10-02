// Pitch Log - AI contact lookup
// Flow: validate request -> verify user + daily cap via Supabase RPC -> only then call Anthropic.
// Required Netlify env var: ANTHROPIC_API_KEY
// SUPABASE_URL and SUPABASE_ANON_KEY are optional overrides; the public values below are used if they are not set.
// (The anon key is public by design - it is the same one already in index.html. Security comes from the database gate.)
const DEFAULT_SUPABASE_URL = 'https://ydxriywpkkdptwcuqaaj.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkeHJpeXdwa2tkcHR3Y3VxYWFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1Njc5NjYsImV4cCI6MjA5NDE0Mzk2Nn0.SYACMatBKKEZV0Wo3rJ6iPSzt0E14qXjT2DieUsG9Zk';

function json(statusCode, obj) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // --- 1. Basic request validation (before spending a lookup from the cap) ---
  let artist;
  try {
    artist = JSON.parse(event.body || '{}').artist;
  } catch (e) {
    return json(400, { error: 'Invalid request body' });
  }
  if (!artist || typeof artist !== 'string' || !artist.trim()) {
    return json(400, { error: 'Artist name required' });
  }
  artist = artist.trim();
  if (artist.length > 100) {
    return json(400, { error: 'Artist name too long' });
  }

  // --- 2. Config check ---
  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!supabaseUrl || !anonKey || !apiKey) {
    console.log('Missing env var(s). SUPABASE_URL:', !!supabaseUrl,
      'SUPABASE_ANON_KEY:', !!anonKey, 'ANTHROPIC_API_KEY:', !!apiKey);
    return json(500, { error: 'Server not configured' });
  }

  // --- 3. Require the user's access token ---
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return json(403, { error: 'no_access' });
  }
  const accessToken = match[1].trim();

  // --- 4. Guest-list + daily cap check (enforced in the database) ---
  let gate;
  try {
    const gateRes = await fetch(
      supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/pitch_log_use_lookup',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': anonKey,
          'Authorization': 'Bearer ' + accessToken
        },
        body: '{}'
      }
    );

    if (gateRes.status === 401) {
      return json(403, { error: 'no_access' });
    }
    if (!gateRes.ok) {
      console.log('Gate RPC failed, status:', gateRes.status);
      // Fail closed: never call the paid API if the gate can't be verified
      return json(502, { error: 'gate_unavailable' });
    }

    // PostgREST returns a scalar text as a JSON string, e.g. "ok"
    const raw = (await gateRes.text()).trim();
    try { gate = JSON.parse(raw); } catch (e) { gate = raw; }
    if (typeof gate === 'string') gate = gate.replace(/^"|"$/g, '').trim();
  } catch (err) {
    console.log('Gate RPC error:', err.message);
    return json(502, { error: 'gate_unavailable' });
  }

  if (gate === 'no_access') return json(403, { error: 'no_access' });
  if (gate === 'cap_reached') return json(429, { error: 'cap_reached' });
  if (gate !== 'ok') {
    console.log('Unexpected gate response:', gate);
    return json(502, { error: 'gate_unavailable' });
  }

  // --- 5. Paid call (only reached when gate === 'ok') ---
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
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{
          role: 'user',
          content: 'Research current music industry contacts for the country artist "' + artist + '". '
            + 'Search for their personal manager, A&R rep at their record label, and music publisher/creative contact. '
            + 'Return ONLY valid JSON with no markdown, no explanation:\n'
            + '{"manager":{"name":"","company":"","email":"","notes":""},'
            + '"ar":{"name":"","label":"","email":"","notes":""},'
            + '"publisher":{"name":"","company":"","contact":"","email":"","notes":""}}'
        }]
      })
    });

    const data = await response.json();
    if (data.error) {
      console.log('Anthropic API error:', JSON.stringify(data.error));
      return json(502, { error: 'Lookup service error. Try again in a moment.' });
    }

    const text = (data.content || [])
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('');

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        JSON.parse(jsonMatch[0]); // validate it's real JSON
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: jsonMatch[0]
        };
      } catch (parseErr) {
        console.log('JSON parse failed:', parseErr.message);
      }
    }

    return json(200, { error: 'Could not find contacts for this artist.' });

  } catch (err) {
    console.log('Caught error:', err.message);
    return json(500, { error: 'Search failed: ' + err.message });
  }
};

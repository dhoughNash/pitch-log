exports.handler = async function(event) {
  console.log('Function called, method:', event.httpMethod);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let artist;
  try {
    artist = JSON.parse(event.body).artist;
    console.log('Artist requested:', artist);
  } catch(e) {
    console.log('Body parse error:', e.message);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!artist) {
    console.log('No artist provided');
    return { statusCode: 400, body: JSON.stringify({ error: 'Artist name required' }) };
  }

  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!firecrawlKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Firecrawl API key not configured' }) };
  }
  if (!anthropicKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Anthropic API key not configured' }) };
  }

  // ── Firecrawl search helper ─────────────────────────────────────────────
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
        scrapeOptions: { formats: [{ type: 'summary' }] }
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
      return '### ' + (item.title || item.url) + '\n'
        + (item.url || '') + '\n'
        + (item.summary || item.description || '');
    }).join('\n\n');
  }

  try {
    // Run all three searches in parallel; don't let one failure kill the request
    const results = await Promise.allSettled([
      fcSearch(artist + ' country music manager management company', 3),
      fcSearch(artist + ' record label A&R rep contact', 3),
      fcSearch(artist + ' music publisher creative contact', 3)
    ]);

    const managerCtx = results[0].status === 'fulfilled' ? results[0].value : '';
    const arCtx = results[1].status === 'fulfilled' ? results[1].value : '';
    const pubCtx = results[2].status === 'fulfilled' ? results[2].value : '';

    if (!managerCtx && !arCtx && !pubCtx) {
      return { statusCode: 200, body: JSON.stringify({ error: 'No search results found for this artist.' }) };
    }

    const prompt = 'Using ONLY the research notes below, identify current music industry contacts for '
      + 'the country artist "' + artist + '". If the notes do not clearly support a fact, leave that '
      + 'field blank rather than guessing.\n\n'
      + '--- MANAGER RESEARCH ---\n' + (managerCtx || 'No results.') + '\n\n'
      + '--- A&R / LABEL RESEARCH ---\n' + (arCtx || 'No results.') + '\n\n'
      + '--- PUBLISHER RESEARCH ---\n' + (pubCtx || 'No results.') + '\n\n'
      + 'Return ONLY valid JSON with no markdown, no explanation:\n'
      + '{"manager":{"name":"","company":"","email":"","notes":""},'
      + '"ar":{"name":"","label":"","email":"","notes":""},'
      + '"publisher":{"name":"","company":"","contact":"","email":"","notes":""}}';

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
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    console.log('Anthropic response status:', response.status);
    const data = await response.json();
    if (data.error) console.log('API error:', JSON.stringify(data.error));

    const text = (data.content || [])
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('');

    console.log('Text extracted, length:', text.length);

    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        JSON.parse(match[0]);
        console.log('Valid JSON found, returning results');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: match[0]
        };
      } catch(parseErr) {
        console.log('JSON parse failed:', parseErr.message);
      }
    } else {
      console.log('No JSON match found in text');
    }

    return { statusCode: 200, body: JSON.stringify({ error: 'Could not find contacts for this artist.' }) };

  } catch(err) {
    console.log('Caught error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Search failed: ' + err.message }) };
  }
};

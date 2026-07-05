exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let artist;
  try {
    artist = JSON.parse(event.body).artist;
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!artist) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Artist name required' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
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
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
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
    const text = (data.content || [])
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('');

    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      JSON.parse(match[0]); // validate it's real JSON
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: match[0]
      };
    }

    return { statusCode: 200, body: JSON.stringify({ error: 'Could not find contacts for this artist.' }) };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Search failed: ' + err.message }) };
  }
};

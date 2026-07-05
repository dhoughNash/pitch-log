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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log('API key present:', !!apiKey, '| Length:', apiKey ? apiKey.length : 0);

  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  try {
    console.log('Calling Anthropic API...');
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

    console.log('Anthropic response status:', response.status);
    const data = await response.json();
    console.log('Response type:', data.type);
    console.log('Content blocks:', data.content ? data.content.length : 0);
    if (data.error) console.log('API error:', JSON.stringify(data.error));

    const text = (data.content || [])
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('');

    console.log('Text extracted, length:', text.length);
    console.log('Text preview:', text.slice(0, 200));

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

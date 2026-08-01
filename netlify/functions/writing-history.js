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
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: 'Research the country music artist "' + artist + '" and their released discography '
            + '(prioritize their most recent album plus singles from roughly the last 3-4 years). For each '
            + 'song you can confirm, determine whether the artist is credited as a co-writer/writer versus '
            + 'a song written entirely by outside songwriters (the artist recorded it but has no writing credit). '
            + 'Use sources like song credit databases, Wikipedia discography pages, ASCAP/BMI/SESAC repertoire '
            + 'search, or Genius credit pages. Be conservative: only count a song if you can actually verify the '
            + 'writing credits, and say clearly if data is thin. '
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
    if (match) {
      try {
        JSON.parse(match[0]);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: match[0]
        };
      } catch(parseErr) {
        return { statusCode: 200, body: JSON.stringify({ error: 'Could not parse a clean result for this artist.' }) };
      }
    }

    return { statusCode: 200, body: JSON.stringify({ error: 'Could not find writing-credit history for this artist.' }) };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Search failed: ' + err.message }) };
  }
};

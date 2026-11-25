// A small GitHub REST client: fetch, a token, pagination. No dependencies.

export function githubClient({ token, api = process.env.GITHUB_API_URL || 'https://api.github.com' }) {
  async function request(method, url, body) {
    const response = await fetch(url.startsWith('http') ? url : `${api}${url}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'journeyboard',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`GitHub ${method} ${url}: ${response.status} ${text.slice(0, 300)}`);

      error.status = response.status;
      throw error;
    }

    return { data: response.status === 204 ? null : await response.json(), link: response.headers.get('link') ?? '' };
  }

  return {
    get: async (url) => (await request('GET', url)).data,
    post: async (url, body) => (await request('POST', url, body)).data,
    patch: async (url, body) => (await request('PATCH', url, body)).data,
    /** Every item of a list endpoint, following `Link: rel="next"`. */
    async all(url) {
      const items = [];
      let next = url + (url.includes('?') ? '&' : '?') + 'per_page=100';

      while (next) {
        const { data, link } = await request('GET', next);

        items.push(...(Array.isArray(data) ? data : []));
        next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? '';
      }

      return items;
    },
  };
}

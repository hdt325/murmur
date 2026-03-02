// Proxy all requests to the Cloudflare Pages deployment
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = "murmur-site-ejk.pages.dev";
    const response = await fetch(new Request(url, request), {
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    return new Response(response.body, { status: response.status, headers });
  },
};
